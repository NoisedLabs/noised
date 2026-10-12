/**
 * End-to-end flows against the simulated chain (the VITE_NOISED_MOCK=1
 * backend), with the adapter's SDK functions for everything pure: every
 * transaction is simulated before it is sent, exactly like the UI does.
 * The simulated chain follows the PQ v2 programs: a launch goes live only
 * with its creator's attestation and inside the attested window (sent by
 * anyone), the batch spends min(total, cap) and fills every commit pro rata
 * (its share can be paid into a PQ vault), the snipe shield lets only the
 * batch buy through, and vault v4 rotates keys in place, reserves payouts at
 * withdraw and delivers them with release / release_to.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { CERTIFICATE_CHECK_LABELS } from "../src/lib/display";
import { demoAttestation, FIXTURES, fixtureMetadata, publishDemoTokenMeta, seedState } from "../src/lib/mock/fixtures";
import { mockSignDeterministic } from "../src/lib/mock/lmotsSigner";
import { hookEvaluate } from "../src/lib/mock/market";
import { addTokens, replaceStateForTests, state } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import type * as T from "../src/lib/noised";
import { claimRefundNote, closesWsolAccount, commitWsolNote, swapWsolNote } from "../src/lib/wsol";

/** The adapter as a mock build sees it: SDK pure functions plus the simulated chain. */
const phx = { ...adapter, ...mock };

/** Never contacted: the mock adapter ignores the connection. */
const conn = new Connection("http://127.0.0.1:8899");
const now = (): number => Math.floor(Date.now() / 1000);

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

/** Simulate, then send: the only path the UI offers. */
async function land(tx: T.AnyTransaction): Promise<string> {
  const sim = await phx.simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`simulation failed: ${sim.error ?? "?"}`);
  expect(sim.unknownPrograms).toEqual([]);
  return phx.sendAndConfirm(conn, tx);
}

beforeEach(() => {
  replaceStateForTests(seedState());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fixtures and verification", () => {
  it("cover every phase and batch outcome", async () => {
    const launches = await phx.listLaunches(conn);
    const phases = new Set(launches.map((l) => phx.launchPhase(l, BigInt(now()))));
    expect(phases).toEqual(new Set(["commit", "guarded", "open", "graduated", "configured"]));
    expect(phx.batchOutcome(await launchBySymbol("EMBR"), BigInt(now()))).toBe("expired");
    expect(phx.batchOutcome(await launchBySymbol("BSTN"), BigInt(now()))).toBe("executed");
  });

  it("passes clean launches, warns on an operator-raised pool fee, fails non-Noised mints", async () => {
    const meridian = await launchBySymbol("MRDN");
    const ok = await phx.verifyLaunch(conn, meridian.baseMint);
    // Everything passes: the name and symbol are the on-chain record's, which the identity signed by its hash.
    expect(ok.overall).toBe("pass");
    expect(ok.checks.filter((c) => c.status !== "pass").map((c) => c.id)).toEqual([]);
    expect(ok.checks.find((c) => c.id === "pq.origin")?.status).toBe("pass");
    expect(ok.pqOrigin?.verified).toBe(true);
    // The SDK 0.4.0 report: the record the certificate names, decoded and verified, and its document (a description
    // and a website, shown as inert text; the demo's icons are its hand-made art, outside the record).
    for (const id of ["metadata.onchain", "metadata.match", "metadata.icon"]) expect(ok.checks.find((c) => c.id === id)?.status, id).toBe("pass");
    expect(ok.checks.some((c) => c.id === "pq.metadataJson")).toBe(false);
    expect(ok.certificate?.version).toBe(4);
    expect(ok.metadata?.verified).toBe(true);
    expect(ok.metadata?.address).toEqual(ok.certificate?.metadata);
    expect(ok.metadata?.record).toMatchObject({ name: "Meridian", symbol: "MRDN", flags: 0, uri: "", tokenUri: "" });
    const spec = FIXTURES.find((f) => f.symbol === "MRDN");
    if (spec === undefined) throw new Error("no MRDN fixture");
    expect(ok.metadata?.document).toMatchObject({ ok: true, empty: false, icon: null, description: spec.description, links: [{ kind: "website", host: "meridian.example", url: spec.website }] });
    expect(ok.pqOrigin?.tokenMeta).toEqual(ok.metadata?.address);
    expect(ok.pqOrigin?.metadataHash).toEqual(phx.metadataHashV2(fixtureMetadata(spec)));
    expect(ok.phase).toBe("graduated");
    expect(ok.certificate?.checks).toBe(phx.CERTIFICATE_ALL_CHECKS);
    // Each certificate flag is re-checked live.
    for (const c of CERTIFICATE_CHECK_LABELS) expect(ok.checks.find((x) => x.id === `certificate.bit${c.bit}`)?.status).toBe("pass");
    const parties = ok.trustedParties.map((p) => p.address?.toBase58());
    expect(parties).toContain("CoEsykatDegLB7pcMJia79JSriDdi71nPnjgeSfw623k");
    expect(parties).toContain("BnD53519LK7QM4ERBGvLedZDe1VoTPgtiBkGPWAACiMZ");

    const cinder = await launchBySymbol("CNDR");
    const warn = await phx.verifyLaunch(conn, cinder.baseMint);
    expect(warn.overall).toBe("warn");
    expect(warn.checks.find((c) => c.id === "damm.fee")?.status).toBe("warn");

    const fail = await phx.verifyLaunch(conn, phx.WSOL_MINT);
    expect(fail.overall).toBe("fail");
    expect(fail.certificate).toBeNull();
    expect(fail.metadata).toBeNull();
  });

  it("knows the metadata records as launchpad accounts, like the cluster (as a fee recipient: a warning, not a missing account)", async () => {
    const meridian = await launchBySymbol("MRDN");
    const spec = FIXTURES.find((f) => f.symbol === "MRDN");
    if (spec === undefined) throw new Error("no MRDN fixture");
    const record = phx.tokenMetaAddress(meridian.publicKey, phx.metadataHashV2(fixtureMetadata(spec)));
    expect(await phx.checkFeeRecipients(conn, [{ wallet: record }])).toEqual({
      ok: true,
      refusals: [],
      warnings: [`recipients[0].wallet: an off-curve account of program ${phx.PROGRAM_IDS.launchpad.toBase58()}: only that program can move what its token account receives`],
    });
  });

  it("fails the metadata checks when the record is missing or the mint's name is not the record's", async () => {
    const lantern = await launchBySymbol("LNTN");
    const cert = (await phx.verifyLaunch(conn, lantern.baseMint)).certificate;
    if (!cert) throw new Error("no certificate");
    // The mint's TokenMetadata no longer says what the record says.
    const l = state().launches[lantern.publicKey.toBase58()];
    if (!l?.meta) throw new Error("missing");
    l.meta = { ...l.meta, name: "Lantern2" };
    const renamed = await phx.verifyLaunch(conn, lantern.baseMint);
    expect(renamed.checks.find((c) => c.id === "metadata.match")).toMatchObject({ status: "fail", detail: "the mint's name is not the record's" });
    expect(renamed.checks.find((c) => c.id === "metadata.onchain")?.status).toBe("pass");
    expect(renamed.metadata?.verified).toBe(false);
    // No record at the address the certificate names.
    delete state().tokenMetas[cert.metadata.toBase58()];
    const missing = await phx.verifyLaunch(conn, lantern.baseMint);
    expect(missing.overall).toBe("fail");
    expect(missing.checks.find((c) => c.id === "metadata.onchain")?.detail).toMatch(/^no valid metadata record at \w+, the address the certificate names$/);
    expect(missing.checks.find((c) => c.id === `certificate.bit${phx.CERTIFICATE_CHECKS.METADATA_ONCHAIN}`)?.status).toBe("fail");
    expect(missing.checks.some((c) => c.id === "metadata.match" || c.id === "metadata.icon")).toBe(false);
    expect(missing.metadata).toMatchObject({ address: cert.metadata, record: null, document: null, verified: false });
  });
});

describe("fair-open batch", () => {
  it("accepts commits above the total cap, refuses only the per-wallet cap, and rejects replays", async () => {
    const user = demoUser();
    const aegis = await launchBySymbol("AEGS");
    // The fixture is already oversubscribed: 61.4 SOL committed for a 40 SOL cap.
    expect(aegis.totalCommitted).toBeGreaterThan(aegis.batchTotalCap);
    const before = phx.expectedBatchFill(aegis);
    expect(before.oversubscribed).toBe(true);
    expect(before.fill).toBe(aegis.batchTotalCap);

    const tx = await phx.buildCommitTx(conn, user, aegis.publicKey, 2_000_000_000n);
    await land(tx);
    expect((await phx.fetchCommit(conn, aegis.publicKey, user))?.amount).toBe(2_000_000_000n);
    const after = await phx.fetchLaunch(conn, aegis.publicKey);
    if (!after) throw new Error("missing");
    expect(after.totalCommitted).toBe(aegis.totalCommitted + 2_000_000_000n);
    // Every commit gets the same, lower fill; this one is spent at that rate and the rest comes back at claim.
    const fill = phx.expectedBatchFill(after, 0n, 2_000_000_000n);
    expect(fill.fillBps).toBeLessThan(before.fillBps);
    expect(fill.commit.refund).toBe(((after.totalCommitted - after.batchTotalCap) * 2_000_000_000n) / after.totalCommitted);
    expect(fill.commit.spent + fill.commit.refund).toBe(2_000_000_000n);

    // The per-wallet cap (5 SOL in the fair preset) is the only refusal, like the SDK's builder.
    await expect(phx.buildCommitTx(conn, user, aegis.publicKey, 3_500_000_000n)).rejects.toThrow(/per-wallet batch cap/);
    await expect(phx.sendAndConfirm(conn, tx)).rejects.toThrow(/already/i);
  });

  /** The demo chain's record of `owner`'s wSOL account (undefined: it does not exist). */
  const wsolOf = (owner: PublicKey): bigint | undefined => state().tokens[`${owner.toBase58()}:${phx.WSOL_MINT.toBase58()}`];
  const giveWsolAccount = (owner: PublicKey, wsol: bigint): void => {
    state().tokens[`${owner.toBase58()}:${phx.WSOL_MINT.toBase58()}`] = wsol;
  };

  it("a commit closes the wSOL account it creates and leaves an existing one as it is (like the SDK), and its review says so", async () => {
    const user = demoUser();
    const aegis = await launchBySymbol("AEGS");
    const fresh = await phx.buildCommitTx(conn, user, aegis.publicKey, 1_000_000_000n);
    expect(closesWsolAccount(fresh, user)).toBe(true);
    expect(commitWsolNote(closesWsolAccount(fresh, user))).toMatch(/creates a temporary wSOL account .* closes it again/i);
    await land(fresh);
    expect(wsolOf(user)).toBeUndefined();

    // A wSOL account that exists before the transaction (holding 7 lamports of wSOL) stays open, and keeps its wSOL.
    giveWsolAccount(user, 7n);
    const kept = await phx.buildCommitTx(conn, user, aegis.publicKey, 1_000_000_000n);
    expect(closesWsolAccount(kept, user)).toBe(false);
    expect(commitWsolNote(closesWsolAccount(kept, user))).toMatch(/existing wSOL account and leaves that account open/);
    const before = await phx.getSolBalance(conn, user);
    await land(kept);
    expect(wsolOf(user)).toBe(7n);
    expect(before - (await phx.getSolBalance(conn, user))).toBe(1_000_000_000n + 5_000n);
    expect((await phx.fetchCommit(conn, aegis.publicKey, user))?.amount).toBe(2_000_000_000n);
  });

  it("a claim unwraps its refund only when it creates the owner's wSOL account (like the SDK), and its review says so", async () => {
    const ember = await launchBySymbol("EMBR");
    // The owner claims for itself without a wSOL account: the claim creates it and closes it, the refund arrives as SOL.
    const a = demoUser();
    const ca = await phx.buildClaimTx(conn, a, ember.publicKey, a);
    expect(closesWsolAccount(ca, a)).toBe(true);
    expect(claimRefundNote("1.2 SOL", closesWsolAccount(ca, a))).toMatch(/as SOL/);
    const solA = await phx.getSolBalance(conn, a);
    await land(ca);
    expect(wsolOf(a)).toBeUndefined();
    expect((await phx.getSolBalance(conn, a)) - solA).toBe(1_200_000_000n - 5_000n);

    // With an existing wSOL account, the refund stays wSOL in it.
    const b = demoUser();
    giveWsolAccount(b, 0n);
    const cb = await phx.buildClaimTx(conn, b, ember.publicKey, b);
    expect(closesWsolAccount(cb, b)).toBe(false);
    expect(claimRefundNote("1.2 SOL", closesWsolAccount(cb, b))).toMatch(/as wSOL into your wSOL account, which stays open/);
    const solB = await phx.getSolBalance(conn, b);
    await land(cb);
    expect(wsolOf(b)).toBe(1_200_000_000n);
    expect(solB - (await phx.getSolBalance(conn, b))).toBe(5_000n);

    // A third party cannot close it: the refund stays wSOL, and the cranker pays the new account's rent.
    const c = demoUser();
    const cranker = demoUser();
    const cc = await phx.buildClaimTx(conn, cranker, ember.publicKey, c);
    expect(closesWsolAccount(cc, c)).toBe(false);
    const solCranker = await phx.getSolBalance(conn, cranker);
    await land(cc);
    expect(wsolOf(c)).toBe(1_200_000_000n);
    expect(solCranker - (await phx.getSolBalance(conn, cranker))).toBe(5_000n + 2_039_280n);
  });

  it("a DAMM v2 swap closes only a wSOL account it creates, Meteora's DBC swap always closes it (like the SDK and Meteora's SDK)", async () => {
    const meridian = await launchBySymbol("MRDN");
    const lantern = await launchBySymbol("LNTN");
    expect(meridian.market?.migrated).toBe(true);
    expect(lantern.market?.migrated).toBe(false);
    const user = demoUser();
    const amount = 1_000n * 10n ** BigInt(meridian.tokenDecimal);
    const fresh = await phx.buildSwapTx(conn, user, meridian.baseMint, "sell", amount, 300);
    expect(closesWsolAccount(fresh.tx, user)).toBe(true);
    expect(swapWsolNote("sell", true)).toMatch(/Unwraps the wSOL you receive/);

    giveWsolAccount(user, 5n);
    const kept = await phx.buildSwapTx(conn, user, meridian.baseMint, "sell", amount, 300);
    expect(closesWsolAccount(kept.tx, user)).toBe(false);
    expect(swapWsolNote("sell", false)).toMatch(/stays wrapped/);
    const sol = await phx.getSolBalance(conn, user);
    await land(kept.tx);
    expect(wsolOf(user)).toBeGreaterThan(5n);
    expect(sol - (await phx.getSolBalance(conn, user))).toBe(5_000n);

    // Meteora's DBC swap closes the wSOL account whatever it held: its wSOL comes back as SOL.
    const held = wsolOf(user) ?? 0n;
    const dbc = await phx.buildSwapTx(conn, user, lantern.baseMint, "buy", 100_000_000n, 300);
    expect(closesWsolAccount(dbc.tx, user)).toBe(true);
    const before = await phx.getSolBalance(conn, user);
    await land(dbc.tx);
    expect(wsolOf(user)).toBeUndefined();
    expect((await phx.getSolBalance(conn, user)) - before).toBe(held - 100_000_000n - 5_000n);
  });

  it("blocks every buy during the snipe shield, exempt owners and zero outputs included, and never blocks sells", async () => {
    const user = demoUser();
    const aegis = await launchBySymbol("AEGS");
    const { tx } = await phx.buildSwapTx(conn, user, aegis.baseMint, "buy", 100_000_000n, 100);
    const sim = await phx.simulateAndExplain(conn, tx);
    expect(sim.ok).toBe(false);
    expect(sim.errorCode?.name).toBe("SnipeShield");
    expect(sim.logs.join("\n")).toMatch(/AnchorError occurred\. Error Code: SnipeShield/);

    // The rules of programs/noised-hook/src/rules.rs: only the batch buy passes the shield.
    const l = state().launches[aegis.publicKey.toBase58()];
    if (!l) throw new Error("missing");
    const pdas = phx.launchPdasFromLaunch(aegis.publicKey);
    const buy = { isBuy: true, isSell: false, sourceOwner: phx.KNOWN_ACCOUNTS.dbcPoolAuthority, destinationBalanceAfter: 1n };
    expect(hookEvaluate(l, now(), { ...buy, amount: 5n, destinationOwner: pdas.batchAuthority })).toBe("SnipeShield");
    expect(hookEvaluate(l, now(), { ...buy, amount: 0n, destinationOwner: user })).toBe("SnipeShield");
    expect(hookEvaluate(l, now(), { ...buy, amount: 5n, destinationOwner: pdas.batchAuthority, inBatch: true })).toBeNull();
    // After the shield, exempt owners skip the caps again.
    expect(hookEvaluate(l, Number(aegis.executeEndTs) + 1, { ...buy, amount: 10n ** 18n, destinationOwner: pdas.batchAuthority, destinationBalanceAfter: 10n ** 18n })).toBeNull();

    const lantern = await launchBySymbol("LNTN");
    const held = await phx.getTokenBalance(conn, user, lantern.baseMint);
    expect(held).toBeGreaterThan(0n);
    const sell = await phx.buildSwapTx(conn, user, lantern.baseMint, "sell", 1_000_000_000n, 100);
    expect(sell.quote.minimumOut).toBeLessThanOrEqual(sell.quote.expectedOut);
    await land(sell.tx);
    expect(await phx.getTokenBalance(conn, user, lantern.baseMint)).toBe(held - 1_000_000_000n);
  });

  it("pays an oversubscribed executed batch pro rata (tokens and the unspent SOL) and refunds an expired batch in full", async () => {
    const user = demoUser();
    const bastion = await launchBySymbol("BSTN");
    const ember = await launchBySymbol("EMBR");
    const mine = await phx.fetchCommit(conn, bastion.publicKey, user);
    expect(mine?.amount).toBe(2_500_000_000n);
    const b0 = await phx.fetchLaunch(conn, bastion.publicKey);
    if (!b0 || !mine) throw new Error("missing");
    // The batch spent its 150 SOL cap of everything committed; the rest is refunded pro rata.
    expect(b0.quoteSpent).toBe(b0.batchTotalCap);
    const share = phx.batchShare(mine.amount, b0.totalCommitted, b0.quoteSpent, b0.tokensOut);
    expect(share?.refund).toBeGreaterThan(0n);
    expect(phx.expectedBatchFill(b0, 0n, mine.amount).commit).toEqual({ amount: mine.amount, spent: mine.amount - (share?.refund ?? 0n), refund: share?.refund, tokens: share?.tokens });

    const solBefore = await phx.getSolBalance(conn, user);
    await land(await phx.buildClaimTx(conn, user, bastion.publicKey, user));
    expect(await phx.getTokenBalance(conn, user, bastion.baseMint)).toBe(share?.tokens);
    // The refund, minus the network fee and the new token account's rent.
    expect((await phx.getSolBalance(conn, user)) - solBefore).toBeGreaterThan((share?.refund ?? 0n) - 3_000_000n);
    await expect(phx.buildClaimTx(conn, user, bastion.publicKey, user)).rejects.toThrow(/already been claimed/);

    const solMid = await phx.getSolBalance(conn, user);
    await land(await phx.buildClaimTx(conn, user, ember.publicKey, user));
    const e = await phx.fetchLaunch(conn, ember.publicKey);
    expect((e?.quoteRefunded ?? 0n) - ember.quoteRefunded).toBe(1_200_000_000n);
    expect((await phx.fetchCommit(conn, ember.publicKey, user))?.claimed).toBe(true);
    const delta = (await phx.getSolBalance(conn, user)) - solMid;
    expect(delta).toBeGreaterThan(1_190_000_000n);
    expect(delta).toBeLessThanOrEqual(1_200_000_000n);
  });

  it("executes only as the pool's first swap: a traded pool can only refund (PoolAlreadyTraded)", async () => {
    const aegis = await launchBySymbol("AEGS");
    const l = state().launches[aegis.publicKey.toBase58()];
    if (!l) throw new Error("missing");
    expect((await phx.verifyLaunch(conn, aegis.baseMint)).checks.find((c) => c.id === "batch.firstSwap")?.status).toBe("pass");
    l.hasSwap = true;
    await expect(phx.buildExecuteBatchTx(conn, demoUser(), aegis.publicKey)).rejects.toThrow(/PoolAlreadyTraded/);
    const report = await phx.verifyLaunch(conn, aegis.baseMint);
    expect(report.checks.find((c) => c.id === "batch.firstSwap")?.status).toBe("warn");
    expect(report.checks.find((c) => c.id === "batch.accounting")?.detail).toMatch(/oversubscribed/);
  });

  it("runs a whole launch: create, attested window, permissionless launch, oversubscribed commits, execute, pro-rata claims, trade, fees", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-08T12:00:00Z");
    vi.setSystemTime(t0);
    replaceStateForTests(seedState());
    const creator = demoUser();
    const alice = demoUser();
    const cranker = demoUser();
    const recipient = Keypair.generate().publicKey;
    const SOL = 1_000_000_000n;
    // A 4 SOL cap (10% of the 40 SOL threshold): the 6 SOL committed below is filled pro rata.
    const pqIdentity = new Uint8Array(32).fill(0x2a);
    const params: T.LaunchParamsInput = { ...phx.PRESETS.turbo.params, batchTotalCap: 4n * SOL, recipients: [{ wallet: recipient, bps: 10_000 }], pqIdentity };
    expect(phx.validateLaunchParams(params).ok).toBe(true);
    // The launch names the creator's post-quantum identity: an all-zero one is refused.
    await expect(phx.buildCreateLaunchTx(conn, creator, { ...params, pqIdentity: new Uint8Array(32) })).rejects.toThrow(/pqIdentity/);

    const created = await phx.buildCreateLaunchTx(conn, creator, params);
    await land(created.tx);
    const configured = await phx.fetchLaunch(conn, created.launch);
    expect(configured?.status).toBe("configured");
    expect(phx.launchPhase(configured as T.LaunchAccount, BigInt(now()))).toBe("configured");
    expect(configured?.paramsHash).toEqual(phx.launchParamsHash({ ...phx.PRESETS.turbo.params, batchTotalCap: 4n * SOL, recipients: params.recipients, pqIdentity }));
    expect(configured?.pqIdentity).toEqual(pqIdentity);

    // Nothing goes live before the creator's identity attests it.
    const mint = Keypair.generate();
    const metadata = { name: "Test", symbol: "TST" };
    await expect(phx.buildLaunchTx(conn, alice, created.launch, mint)).rejects.toThrow(/not attested yet/);
    // The identity signs the launch, its metadata record (by its hash) and a window opening in a minute (the attest flow writes this account).
    const opensAt = BigInt(now() + 60);
    const l = state().launches[created.launch.toBase58()];
    if (!l) throw new Error("missing");
    state().attestations[created.launch.toBase58()] = demoAttestation(l, metadata, { notBefore: opensAt, notAfter: opensAt + 3_600n }, 1);
    expect((await phx.fetchAttestation(conn, created.launch))?.attested).toBe(true);
    // `launch` copies the name and symbol from the record the attestation names: without it, nothing goes live
    // (another record under the same launch, which anyone may publish, does not count).
    const missingRecord = /the metadata record the attestation names does not exist \(AccountNotInitialized\)/;
    await expect(phx.buildLaunchTx(conn, alice, created.launch, mint)).rejects.toThrow(missingRecord);
    publishDemoTokenMeta(state(), created.launch, { name: "Test", symbol: "OTHER" });
    await expect(phx.buildLaunchTx(conn, alice, created.launch, mint)).rejects.toThrow(missingRecord);
    const record = publishDemoTokenMeta(state(), created.launch, metadata);
    expect(record.publicKey).toEqual(phx.tokenMetaAddress(created.launch, phx.metadataHashV2(metadata)));
    await expect(phx.buildLaunchTx(conn, alice, created.launch, mint)).rejects.toThrow(/NotLaunchWindow/);
    vi.setSystemTime(new Date(Number(opensAt) * 1000));
    // Then anyone may open it inside the window (no creator signature, no arguments); the chain re-checks the record when it lands.
    const launchTx = (await phx.buildLaunchTx(conn, alice, created.launch, mint)).tx;
    const recordBytes = state().tokenMetas[record.publicKey.toBase58()];
    delete state().tokenMetas[record.publicKey.toBase58()];
    const noRecord = await phx.simulateAndExplain(conn, launchTx);
    expect(noRecord.ok).toBe(false);
    expect(noRecord.error).toMatch(/token_meta\. Error Code: AccountNotInitialized/);
    if (recordBytes === undefined) throw new Error("no record bytes");
    state().tokenMetas[record.publicKey.toBase58()] = recordBytes;
    await land(launchTx);
    await expect(phx.buildLaunchTx(conn, creator, created.launch, Keypair.generate())).rejects.toThrow(/already been launched/);

    const live = await phx.fetchLaunchByMint(conn, mint.publicKey);
    if (!live) throw new Error("launch not live");
    expect(phx.launchPhase(live, BigInt(now()))).toBe("commit");
    const verified = await phx.verifyLaunch(conn, mint.publicKey);
    // Everything passes: the mint has exactly the record's name and symbol, and an empty uri.
    expect(verified.checks.filter((c) => c.status !== "pass").map((c) => c.id)).toEqual([]);
    expect(verified.metadata).toMatchObject({ verified: true, record: { name: "Test", symbol: "TST", tokenUri: "" } });
    expect(live.market).toMatchObject({ name: "Test", symbol: "TST", uri: "" });
    expect(verified.checks.find((c) => c.id === "pq.origin")?.status).toBe("pass");
    expect(verified.pqOrigin).toMatchObject({ verified: true, identityId: pqIdentity });
    expect(verified.certificate).toMatchObject({ version: 4, checks: phx.CERTIFICATE_ALL_CHECKS, pqIdentity, metadata: record.publicKey });
    expect(verified.checks.find((c) => c.id === "batch.cap")?.detail).toMatch(/at most 4 SOL, 10% of the 40 SOL migration threshold/);
    expect(verified.checks.find((c) => c.id === "hook.metaList")?.status).toBe("pass");

    // Nobody, including the creator, can buy before the batch.
    const early = await phx.buildSwapTx(conn, creator, mint.publicKey, "buy", 1_000_000_000n, 100);
    expect((await phx.simulateAndExplain(conn, early.tx)).errorCode?.name).toBe("SnipeShield");

    // Order does not matter: the first and the last commit get the same fill.
    await land(await phx.buildCommitTx(conn, alice, live.publicKey, 4_500_000_000n));
    await land(await phx.buildCommitTx(conn, creator, live.publicKey, 1_500_000_000n));
    const pending = await phx.fetchLaunch(conn, live.publicKey);
    if (!pending) throw new Error("missing");
    const aliceFill = phx.expectedBatchFill(pending, 0n, 4_500_000_000n);
    const creatorFill = phx.expectedBatchFill(pending, 0n, 1_500_000_000n);
    expect(aliceFill.oversubscribed).toBe(true);
    expect(aliceFill.commit.refund).toBe(1_500_000_000n);
    expect(creatorFill.commit.refund).toBe(500_000_000n);
    // Execute is refused during the commit window.
    expect((await phx.simulateAndExplain(conn, await phx.buildExecuteBatchTx(conn, cranker, live.publicKey))).errorCode?.name).toBe("NotExecuteWindow");

    // Commit window over: anyone executes the batch, which spends the cap only.
    vi.setSystemTime(new Date(Number(live.commitEndTs) * 1000 + 2_000));
    expect(phx.launchPhase(live, BigInt(now()))).toBe("execute");
    expect((await phx.simulateAndExplain(conn, await phx.buildCommitTx(conn, alice, live.publicKey, 1n))).errorCode?.name).toBe("NotCommitWindow");
    await land(await phx.buildExecuteBatchTx(conn, cranker, live.publicKey));
    const executed = await phx.fetchLaunch(conn, live.publicKey);
    if (!executed) throw new Error("missing");
    expect(executed.executed).toBe(true);
    expect(executed.totalCommitted).toBe(6_000_000_000n);
    expect(executed.quoteSpent).toBe(4n * SOL);
    // The execute phase ends once the batch executed (it ends the snipe shield at once).
    expect(phx.launchPhase(executed, BigInt(now()))).toBe("guarded");
    await expect(phx.buildExecuteBatchTx(conn, cranker, live.publicKey)).rejects.toThrow(/already executed/);

    // Claims: one by the owner, one cranked by a third party; same price and the predicted refunds.
    await land(await phx.buildClaimTx(conn, alice, live.publicKey, alice));
    await land(await phx.buildClaimTx(conn, cranker, live.publicKey, creator));
    const a = await phx.getTokenBalance(conn, alice, mint.publicKey);
    const c = await phx.getTokenBalance(conn, creator, mint.publicKey);
    const aShare = phx.batchShare(4_500_000_000n, executed.totalCommitted, executed.quoteSpent, executed.tokensOut);
    expect(a).toBe(aShare?.tokens);
    expect(aShare?.refund).toBe(aliceFill.commit.refund);
    expect(c).toBe(phx.batchShare(1_500_000_000n, executed.totalCommitted, executed.quoteSpent, executed.tokensOut)?.tokens);
    // Pro rata: 3x the commit, 3x the tokens (within rounding).
    expect(a - 3n * c).toBeLessThanOrEqual(3n);
    expect((await phx.fetchLaunch(conn, live.publicKey))?.quoteRefunded).toBe(2n * SOL);

    // After the execution window public trading opens (guarded).
    vi.setSystemTime(new Date(Number(live.executeEndTs) * 1000 + 1_000));
    expect(phx.launchPhase(executed, BigInt(now()))).toBe("guarded");
    const buy = await phx.buildSwapTx(conn, cranker, mint.publicKey, "buy", 500_000_000n, 300);
    await land(buy.tx);
    expect(await phx.getTokenBalance(conn, cranker, mint.publicKey)).toBe(buy.quote.expectedOut);

    // Fees flow only along the fixed routes; claiming is permissionless.
    await land(await phx.buildClaimFeesTx(conn, cranker, live.publicKey));
    // Every share is paid to ATA(recipient, wSOL) (a wSOL PQ vault recipient is paid into the vault's own token account).
    const recipientBefore = await phx.getTokenBalance(conn, recipient, phx.WSOL_MINT);
    await land(await phx.buildDistributeTx(conn, cranker, live.publicKey));
    expect(await phx.getTokenBalance(conn, recipient, phx.WSOL_MINT)).toBeGreaterThan(recipientBefore);
    expect((await phx.simulateAndExplain(conn, await phx.buildDistributeTx(conn, cranker, live.publicKey))).errorCode?.name).toBe("NothingToDo");
  });
});

describe("PQ vault v4", () => {
  /** The key ledger the signatures below are recorded in (the SDK's builder simulates only signatures a ledger holds). */
  let ledger: T.VaultKeyLedger;
  beforeEach(() => {
    ledger = phx.createMemoryVaultKeyLedger();
  });
  const freshMaster = (): Uint8Array => phx.masterFromPhrase(phx.generateRecoveryPhrase());
  const keys = (master: Uint8Array, mint: PublicKey, account = 0) => {
    const genesis = phx.deriveVaultKey(master, "devnet", mint, account, 0);
    return { genesis, vault: phx.vaultAddress(mint, genesis.keyId), at: (sequence: number) => phx.deriveVaultKey(master, "devnet", mint, account, sequence) };
  };
  /** A withdrawal signed by the phrase's key at `sequence` (a test-local signer), recorded in `ledger` like the app's flow records it. */
  const sign = async (master: Uint8Array, mint: PublicKey, vault: PublicKey, sequence: number, recipient: PublicKey, maxAmount: bigint): Promise<T.WithdrawTxArgs> => {
    const key = phx.deriveVaultKey(master, "devnet", mint, 0, sequence);
    const next = phx.deriveVaultKey(master, "devnet", mint, 0, sequence + 1);
    const msg = phx.withdrawMessage(vault, mint, BigInt(sequence), recipient, maxAmount, next.keyId);
    const signature = mockSignDeterministic(key.skSeed, key.pk, msg);
    if ((await ledger.reserve(key.keyId, msg, { vault, sequence: BigInt(sequence), key: key.pk })) !== "conflict") await ledger.recordSignature(key.keyId, msg, signature, next.pk);
    return { mint, vault, sequence: BigInt(sequence), destinationOwner: recipient, maxAmount, signature, nextKey: next.pk, nextKeyId: next.keyId };
  };

  it("checks mint eligibility like open_vault (close authority included), with warnings", async () => {
    const [dUsd, dPau, dPdg, dFee, dSbt, dCls] = phx.demoMints();
    if (!dUsd || !dPau || !dPdg || !dFee || !dSbt || !dCls) throw new Error("demo mints missing");
    const usd = await phx.checkVaultMint(conn, dUsd.address);
    expect(usd.eligible).toBe(true);
    expect(usd.warnings.join(" ")).toMatch(/Freeze authority .* delay payouts/);
    expect((await phx.checkVaultMint(conn, dPau.address)).warnings.join(" ")).toMatch(/Pause authority/);
    expect((await phx.checkVaultMint(conn, dPdg.address)).refusals.join(" ")).toMatch(/PermanentDelegate/);
    expect((await phx.checkVaultMint(conn, dFee.address)).refusals.join(" ")).toMatch(/TransferFeeConfig authority/);
    expect((await phx.checkVaultMint(conn, dSbt.address)).eligible).toBe(false);
    expect((await phx.checkVaultMint(conn, dCls.address)).refusals.join(" ")).toMatch(/MintCloseAuthority .* re-created/);
    expect((await phx.checkVaultMint(conn, Keypair.generate().publicKey)).eligible).toBe(false);
    // A Noised launch while its hook is active: eligible, with Launch Guard warnings.
    const aegis = await launchBySymbol("AEGS");
    const a = await phx.checkVaultMint(conn, aegis.baseMint);
    expect(a.eligible).toBe(true);
    expect(a.warnings.join(" ")).toMatch(/Launch Guard/);
    // After graduation the hook is revoked: only the Token-2022 note remains.
    const meridian = await launchBySymbol("MRDN");
    const m = await phx.checkVaultMint(conn, meridian.baseMint);
    expect(m.eligible).toBe(true);
    expect(m.warnings).toEqual([expect.stringMatching(/^Token-2022 is upgradeable/)]);
    // Like the SDK, open_vault is not even built for a refused mint.
    const k = phx.deriveVaultKey(freshMaster(), "devnet", dPdg.address, 0, 0);
    await expect(phx.buildOpenVaultTx(conn, demoUser(), dPdg.address, k.pk)).rejects.toThrow(/open_vault would refuse this mint/);
    await expect(phx.buildOpenVaultTx(conn, demoUser(), dUsd.address, phx.deriveVaultKey(freshMaster(), "devnet", dUsd.address, 0, 1).pk)).rejects.toThrow(/genesis key/);
  });

  it("one address forever: open, deposit into the token account, withdraw + release in one v1 transaction, rotate the key", async () => {
    const user = demoUser();
    const recipient = Keypair.generate().publicKey;
    const mint = (await launchBySymbol("MRDN")).baseMint;
    const master = freshMaster();
    const { genesis, vault, at } = keys(master, mint);

    await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
    await expect(phx.buildOpenVaultTx(conn, user, mint, genesis.pk)).rejects.toThrow(/already open/);
    const opened = await phx.fetchVault(conn, vault);
    expect(opened).toMatchObject({ sequence: 0n, reserved: 0n, balance: 0n, available: 0n });
    expect(opened?.tokenAccount.equals(phx.associatedTokenAddress(vault, mint, phx.KNOWN_ACCOUNTS.token2022))).toBe(true);
    await land(await phx.buildDepositTx(conn, user, mint, vault, 1_000n));
    expect((await phx.fetchVault(conn, vault))?.balance).toBe(1_000n);

    expect(await phx.checkRecipient(conn, recipient, mint, vault)).toMatchObject({ ok: true, refusals: [] });
    const args = await sign(master, mint, vault, 0, recipient, 400n);
    // Deterministic: signing the identical message again returns the identical signature.
    expect((await sign(master, mint, vault, 0, recipient, 400n)).signature).toEqual(args.signature);
    // The SDK's builder (and the mock's) simulates only a signature the ledger holds: a simulation reveals it.
    await expect(phx.buildWithdrawTxWithFallback(conn, Keypair.generate(), args, { ledger: phx.createMemoryVaultKeyLedger() })).rejects.toThrow(/does not hold this signature/);
    expect(new TextDecoder().decode(phx.withdrawMessage(vault, mint, 0n, recipient, 400n, args.nextKeyId).subarray(0, 8))).toBe("PHX-PQV4");

    const feePayer = Keypair.generate();
    const unfunded = await phx.buildWithdrawTxWithFallback(conn, feePayer, args, { ledger });
    // Like the SDK, a failure of the pair as a whole (here: no SOL for the fee) falls back to the withdrawal alone, which fails too.
    expect(unfunded.includesRelease).toBe(false);
    expect(unfunded.releaseError).toMatch(/fails as a whole/);
    expect(unfunded.simulation.ok).toBe(false);
    expect(unfunded.simulation.error).toMatch(/fee payer has no SOL/);
    await land(await phx.buildFundFeePayerTx(conn, user, feePayer.publicKey, phx.FEE_PAYER_FUNDING_LAMPORTS));
    const plan = await phx.buildWithdrawTxWithFallback(conn, feePayer, args, { ledger });
    expect(plan).toMatchObject({ includesRelease: true, releaseError: null, expectedAmount: 400n, computeUnitLimit: 330_000, priorityFeeLamports: 0n });
    // The SDK's defaults: withdraw 200k plus a Token-2022 release (no hook any more: the token graduated) 130k.
    expect(plan.simulation.ok).toBe(true);
    expect(plan.tx[0]).toBe(0x81);
    expect(plan.tx.length).toBeLessThanOrEqual(phx.VAULT.V1_MAX_TX_BYTES);
    const decoded = phx.decodeV1Transaction(plan.tx);
    expect(decoded.accountKeys[0]?.equals(feePayer.publicKey)).toBe(true);
    expect(decoded.header.numRequiredSignatures).toBe(1);
    expect(decoded.instructions).toHaveLength(2);
    expect(plan.payout.equals(phx.payoutAddress(vault, 0n))).toBe(true);
    const feePayerBefore = await phx.getSolBalance(conn, feePayer.publicKey);
    await land(plan.tx);

    // Paid, rotated in place, and the payout account's rent is back with the fee payer.
    expect(await phx.getTokenBalance(conn, recipient, mint)).toBe(400n);
    const after = await phx.fetchVault(conn, vault);
    expect(after).toMatchObject({ sequence: 1n, balance: 600n, reserved: 0n, available: 600n });
    expect(after?.keyId).toEqual(at(1).keyId);
    expect(await phx.fetchPayout(conn, vault, 0n)).toBeNull();
    expect(await phx.getSolBalance(conn, feePayer.publicKey)).toBeGreaterThan(feePayerBefore - 3_000_000n);
    const scan = await phx.scanVaults(conn, master, "devnet", mint, 1);
    expect(scan.map((v) => [v.account, v.opened, v.sequence, v.keyMatches, v.balance])).toEqual([
      [0, true, 1n, true, 600n],
      [1, false, 0n, null, 0n],
    ]);
    expect(scan[0]?.vault.equals(vault)).toBe(true);

    // The same bytes cannot land twice, and an old sequence is never rebuilt.
    await expect(phx.sendAndConfirm(conn, plan.tx)).rejects.toThrow(/already/);
    await expect(phx.buildWithdrawTx(conn, feePayer, args)).rejects.toThrow(/already executed/);
    // The old signature is not valid for the next sequence.
    await expect(phx.buildWithdrawTx(conn, feePayer, { ...args, sequence: 1n, nextKey: at(2).pk, nextKeyId: at(2).keyId })).rejects.toThrow(/does not verify/);

    // The next withdrawal is signed by the next key, at the next sequence, from the same address.
    const all = await sign(master, mint, vault, 1, recipient, (1n << 64n) - 1n);
    const second = await phx.buildWithdrawTxWithFallback(conn, feePayer, all, { ledger });
    expect(second.expectedAmount).toBe(600n);
    await land(second.tx);
    expect(await phx.getTokenBalance(conn, recipient, mint)).toBe(1_000n);
    expect((await phx.fetchVault(conn, vault))?.sequence).toBe(2n);

    await land(await phx.buildRefundFeePayerTx(conn, feePayer, user));
    expect(await phx.getSolBalance(conn, feePayer.publicKey)).toBe(0n);
  });

  it("a recipient account that cannot receive delays only its payout: withdraw alone, then release_to another account", async () => {
    const user = demoUser();
    const other = demoUser();
    const recipient = demoUser();
    const dUsd = phx.demoMints()[0];
    if (!dUsd) throw new Error("demo mint missing");
    const mint = dUsd.address;
    const master = freshMaster();
    const { genesis, vault } = keys(master, mint);
    await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
    await land(await phx.buildDepositTx(conn, user, mint, vault, 100_000_000n));
    // The freeze authority froze the recipient's canonical account.
    state().frozen[`${recipient.toBase58()}:${mint.toBase58()}`] = true;

    const check = await phx.checkRecipient(conn, recipient, mint, vault);
    expect(check.ok).toBe(true);
    expect(check.recipientWarnings.join(" ")).toMatch(/it is frozen\. release will fail .* release_to/);
    expect(check.mintWarnings.join(" ")).toMatch(/Freeze authority/);
    const args = await sign(master, mint, vault, 0, recipient, 30_000_000n);
    const feePayer = Keypair.generate();
    await land(await phx.buildFundFeePayerTx(conn, user, feePayer.publicKey, phx.FEE_PAYER_FUNDING_LAMPORTS));
    const plan = await phx.buildWithdrawTxWithFallback(conn, feePayer, args, { ledger });
    expect(plan.includesRelease).toBe(false);
    expect(plan.releaseError).toMatch(/frozen/);
    expect(plan.simulation.ok).toBe(true);
    await land(plan.tx);

    // Executed: the key rotated, the amount is reserved, the payout waits.
    expect(await phx.fetchVault(conn, vault)).toMatchObject({ sequence: 1n, balance: 100_000_000n, reserved: 30_000_000n, available: 70_000_000n });
    const listing = await phx.listPayouts(conn, vault);
    expect(listing.complete).toBe(true);
    expect(listing.payouts.map((p) => [p.sequence, p.amount, p.destinationOwner.toBase58(), p.rentPayer.toBase58()])).toEqual([
      [0n, 30_000_000n, recipient.toBase58(), feePayer.publicKey.toBase58()],
    ]);
    await expect(phx.buildReleaseTx(conn, user, { vault, mint, sequence: 0n })).rejects.toThrow(/cannot receive: it is frozen/);

    // Only the recipient chooses another account.
    const destination = phx.associatedTokenAddress(other, mint, phx.KNOWN_ACCOUNTS.splToken);
    await expect(phx.buildReleaseToTx(conn, user, { vault, mint, sequence: 0n, destination })).rejects.toThrow(/only the payout's recipient/);
    const otherBefore = await phx.getTokenBalance(conn, other, mint);
    const rentPayerBefore = await phx.getSolBalance(conn, feePayer.publicKey);
    await land(await phx.buildReleaseToTx(conn, recipient, { vault, mint, sequence: 0n, destination }));
    expect(await phx.getTokenBalance(conn, other, mint)).toBe(otherBefore + 30_000_000n);
    expect(await phx.fetchVault(conn, vault)).toMatchObject({ balance: 70_000_000n, reserved: 0n, available: 70_000_000n });
    expect(await phx.fetchPayout(conn, vault, 0n)).toBeNull();
    expect(await phx.getSolBalance(conn, feePayer.publicKey)).toBe(rentPayerBefore + 1_740_000n);
    await expect(phx.buildReleaseTx(conn, user, { vault, mint, sequence: 0n })).rejects.toThrow(/already been released/);
  });

  it("the Launch Guard delays only the payout: withdraw executes during the p2p lock, Deliver works after the guard", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const user = demoUser();
    const recipient = Keypair.generate().publicKey;
    const bastion = await launchBySymbol("BSTN");
    const mint = bastion.baseMint;
    const master = freshMaster();
    const { genesis, vault } = keys(master, mint);
    await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
    // Deposits are wallet-to-wallet transfers: refused during the lock.
    await land(await phx.buildClaimTx(conn, user, bastion.publicKey, user));
    const deposit = await phx.simulateAndExplain(conn, await phx.buildDepositTx(conn, user, mint, vault, 1_000n));
    expect(deposit.errorCode).toEqual({ program: "noised_hook", code: 6001, name: "TransfersLocked" });
    // Tokens that reached the vault earlier.
    addTokens(state(), vault, mint, 5_000n);

    // The Launch Guard is the same for every recipient of this token: a token warning, like the live backend's.
    const guarded = await phx.checkRecipient(conn, recipient, mint, vault);
    expect(guarded.mintWarnings.join(" ")).toMatch(/pauses wallet-to-wallet transfers .* delivering it \(release or release_to\) is refused/);
    expect(guarded.recipientWarnings).toEqual([]);
    const args = await sign(master, mint, vault, 0, recipient, 2_000n);
    const feePayer = Keypair.generate();
    await land(await phx.buildFundFeePayerTx(conn, user, feePayer.publicKey, phx.FEE_PAYER_FUNDING_LAMPORTS));

    // A combined transaction sent despite its failing release lands and fails: its signature is public now.
    const combined = await phx.buildWithdrawTx(conn, feePayer, { ...args, includeRelease: true });
    expect((await phx.simulateAndExplain(conn, combined.tx)).failedInstruction).toBe(1);
    await expect(phx.sendAndConfirm(conn, combined.tx)).rejects.toThrow(/TransfersLocked/);
    const search = await phx.findPendingWithdrawal(conn, vault);
    expect(search).toMatchObject({ complete: true, note: null });
    expect(search.all).toHaveLength(1);
    expect(search.pending?.failed).toBe(true);
    expect(search.pending?.signature).toEqual(args.signature);
    expect(search.pending?.txSignature).toBe(combined.signature);

    // Re-broadcast that same signature: the withdrawal goes alone and the payout waits for the guard.
    const plan = await phx.buildWithdrawTxWithFallback(conn, feePayer, args, { ledger });
    expect(plan.includesRelease).toBe(false);
    expect(plan.releaseError).toMatch(/TransfersLocked|wallet-to-wallet/i);
    await land(plan.tx);
    expect((await phx.findPendingWithdrawal(conn, vault)).pending).toBeNull();
    expect(await phx.fetchVault(conn, vault)).toMatchObject({ sequence: 1n, reserved: 2_000n });
    const release = await phx.buildReleaseTx(conn, user, { vault, mint, sequence: 0n });
    expect((await phx.simulateAndExplain(conn, release)).errorCode?.name).toBe("TransfersLocked");

    vi.setSystemTime(new Date(Number(bastion.guardEndTs) * 1000 + 10_000));
    await land(await phx.buildReleaseTx(conn, user, { vault, mint, sequence: 0n }));
    expect(await phx.getTokenBalance(conn, recipient, mint)).toBe(2_000n);
    expect(await phx.fetchVault(conn, vault)).toMatchObject({ balance: 3_000n, reserved: 0n });
  });

  it("refuses recipients that are not wallets before anything is signed", async () => {
    const user = demoUser();
    const dUsd = phx.demoMints()[0];
    if (!dUsd) throw new Error("demo mint missing");
    const mint = dUsd.address;
    const master = freshMaster();
    const { genesis, vault } = keys(master, mint);
    await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
    const refused = async (who: PublicKey): Promise<string> => {
      const c = await phx.checkRecipient(conn, who, mint, vault);
      expect(c.ok).toBe(false);
      return c.refusals.join(" ");
    };
    expect(await refused(vault)).toMatch(/this vault itself/);
    expect(await refused(mint)).toMatch(/is a mint/);
    expect(await refused(phx.associatedTokenAddress(user, mint, phx.KNOWN_ACCOUNTS.splToken))).toMatch(/is a token account/);
    expect(await refused(PublicKey.default)).toMatch(/all-zero address/);
    const otherVault = keys(freshMaster(), mint);
    await land(await phx.buildOpenVaultTx(conn, user, mint, otherVault.genesis.pk));
    expect(await refused(otherVault.vault)).toMatch(/Noised vault program/);
    // An off-curve address with no account needs its own confirmation: a program's unused wallet, or an address nobody can use.
    const pda = PublicKey.findProgramAddressSync([new TextEncoder().encode("x")], phx.PROGRAM_IDS.launchpad)[0];
    const c = await phx.checkRecipient(conn, pda, mint, vault);
    expect(c.ok).toBe(true);
    expect(c.offCurveConfirmation).toMatch(/off the Ed25519 curve .* the payout is lost forever/);
    expect(c.recipientWarnings).toEqual([]);
    // An existing account of another program is a recipient warning: only its program could sign release_to.
    const launch = (await launchBySymbol("AEGS")).publicKey;
    const l = await phx.checkRecipient(conn, launch, mint, vault);
    expect(l.ok).toBe(true);
    expect(l.offCurveConfirmation).toBeNull();
    expect(l.recipientWarnings.join(" ")).toMatch(/is an account of program .*program address \(off the Ed25519 curve\)/);
    // A program is a recipient warning too.
    expect((await phx.checkRecipient(conn, phx.PROGRAM_IDS.launchpad, mint, vault)).recipientWarnings.join(" ")).toMatch(/is a program, not a wallet/);
  });

  it("refuses the addresses the SDK recognises: the vault's own token account, its payout addresses, the connected wallet's token accounts", async () => {
    const user = demoUser();
    const dUsd = phx.demoMints()[0];
    if (!dUsd) throw new Error("demo mint missing");
    const mint = dUsd.address;
    const { genesis, vault } = keys(freshMaster(), mint);
    await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
    const refusal = async (who: PublicKey, wallet: PublicKey | null = null): Promise<string> => {
      const c = await phx.checkRecipient(conn, who, mint, vault, { wallet });
      expect(c.ok, who.toBase58()).toBe(false);
      return c.refusals.join(" ");
    };
    for (const tp of [phx.KNOWN_ACCOUNTS.splToken, phx.KNOWN_ACCOUNTS.token2022]) {
      expect(await refusal(phx.associatedTokenAddress(vault, mint, tp))).toMatch(/this vault's own token account/);
    }
    // Payout addresses near the vault's sequence, whether they exist or not.
    expect(await refusal(phx.payoutAddress(vault, 0n))).toMatch(/payout address of this vault's withdrawal at sequence 0/);
    expect(await refusal(phx.payoutAddress(vault, 64n))).toMatch(/at sequence 64/);
    expect((await phx.checkRecipient(conn, phx.payoutAddress(vault, 65n), mint, vault)).ok).toBe(true);
    // The connected wallet's token accounts of either token program, existing or not.
    const wallet = Keypair.generate().publicKey;
    for (const tp of [phx.KNOWN_ACCOUNTS.splToken, phx.KNOWN_ACCOUNTS.token2022]) {
      expect(await refusal(phx.associatedTokenAddress(wallet, mint, tp), wallet)).toMatch(/your connected wallet's own token account/);
    }
    expect((await phx.checkRecipient(conn, phx.associatedTokenAddress(wallet, mint, phx.KNOWN_ACCOUNTS.splToken), mint, vault)).offCurveConfirmation).not.toBeNull();
  });

  it("searches like the SDK: complete in one call, never a continuation, options checked", async () => {
    const user = demoUser();
    const mint = (phx.demoMints()[0] ?? { address: PublicKey.default }).address;
    const { genesis, vault } = keys(freshMaster(), mint);
    await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
    const search = await phx.findPendingWithdrawal(conn, vault);
    expect(search).toMatchObject({ pending: null, all: [], complete: true, incompleteReason: null, continuation: null, note: null });
    await expect(phx.findPendingWithdrawal(conn, vault, { maxTransactions: 0 })).rejects.toThrow(RangeError);
    await expect(phx.findPendingWithdrawal(conn, vault, { maxSignaturePages: 1 })).rejects.toThrow(/at least 2/);
    const forged = Object.freeze({ vault, sequence: 0n, examined: 0 });
    await expect(phx.findPendingWithdrawal(conn, vault, { continueFrom: forged })).rejects.toThrow(/not a continuation/);
  });

  it("scans vaults from a copy of the master and refuses a wiped one before reading anything (like the SDK)", async () => {
    const user = demoUser();
    const mint = (phx.demoMints()[0] ?? { address: PublicKey.default }).address;
    const master = freshMaster();
    const { genesis, vault } = keys(master, mint);
    await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
    // Wiping the caller's master while the scan waits for the chain changes nothing: it uses its own copy.
    const scan = phx.scanVaults(conn, master, "devnet", mint, 0);
    const copy = Uint8Array.from(master);
    master.fill(0);
    expect((await scan)[0]).toMatchObject({ opened: true, keyMatches: true });
    expect((await scan)[0]?.vault.equals(vault)).toBe(true);
    await expect(phx.scanVaults(conn, master, "devnet", mint, 0)).rejects.toThrow(/all-zero master/);
    await expect(phx.scanVaults(conn, new Uint8Array(32), "devnet", mint, 0)).rejects.toThrow(/64-byte/);
    expect((await phx.scanVaults(conn, copy, "devnet", mint, 0))[0]?.keyMatches).toBe(true);
  });

  it("wSOL deposits wrap automatically: SOL into the vault's token account and SyncNative", async () => {
    const user = demoUser();
    const master = freshMaster();
    const { genesis, vault } = keys(master, phx.WSOL_MINT);
    const open = await phx.buildOpenVaultTx(conn, user, phx.WSOL_MINT, genesis.pk);
    const sim = await phx.simulateAndExplain(conn, open);
    expect(sim.ok).toBe(true);
    expect(sim.programs.map((p) => p.programId.toBase58())).toEqual([phx.PROGRAM_IDS.vault.toBase58()]);
    expect(open.instructions[0]?.keys[4]?.pubkey.equals(phx.KNOWN_ACCOUNTS.splToken)).toBe(true);
    await land(open);
    const before = await phx.getSolBalance(conn, user);
    const deposit = await phx.buildDepositTx(conn, user, phx.WSOL_MINT, vault, 1_000_000_000n);
    const tokenAccount = phx.associatedTokenAddress(vault, phx.WSOL_MINT, phx.KNOWN_ACCOUNTS.splToken);
    expect(deposit.instructions.map((ix) => ix.programId.toBase58())).toEqual([phx.KNOWN_ACCOUNTS.system.toBase58(), phx.KNOWN_ACCOUNTS.splToken.toBase58()]);
    expect(deposit.instructions[0]?.keys[1]?.pubkey.equals(tokenAccount)).toBe(true);
    await land(deposit);
    expect((await phx.fetchVault(conn, vault))?.balance).toBe(1_000_000_000n);
    expect(before - (await phx.getSolBalance(conn, user))).toBe(1_000_005_000n);
  });
});

describe("shield", () => {
  it("keeps the escrow at least the zToken supply", async () => {
    const user = demoUser();
    const meridian = await launchBySymbol("MRDN");
    const mint = meridian.baseMint;
    expect(await phx.fetchShield(conn, mint)).not.toBeNull();
    const a = phx.shieldAddresses(mint);
    const escrow = async (): Promise<bigint> => phx.getTokenBalance(conn, a.authority, mint);
    const supply = async (): Promise<bigint> => phx.getTokenSupply(conn, a.zMint);
    expect(await supply()).toBe(await escrow());
    await land(await phx.buildWrapTx(conn, user, mint, 5_000_000n));
    expect(await phx.getTokenBalance(conn, user, a.zMint)).toBe(5_000_000n);
    await land(await phx.buildUnwrapTx(conn, user, mint, 2_000_000n));
    expect(await escrow()).toBeGreaterThanOrEqual(await supply());
    const tooMuch = await phx.simulateAndExplain(conn, await phx.buildUnwrapTx(conn, user, mint, 4_000_000n));
    expect(tooMuch.ok).toBe(false);
  });

  it("creates shields permissionlessly once, and refuses confidential base mints", async () => {
    const user = demoUser();
    const lantern = await launchBySymbol("LNTN");
    await land(await phx.buildCreateShieldTx(conn, user, lantern.baseMint));
    expect((await phx.fetchShield(conn, lantern.baseMint))?.zMint.equals(phx.shieldAddresses(lantern.baseMint).zMint)).toBe(true);
    expect((await phx.simulateAndExplain(conn, await phx.buildCreateShieldTx(conn, user, lantern.baseMint))).error).toMatch(/already in use/);
    // A zToken (ConfidentialTransferMint) cannot be shielded again.
    const zMint = phx.shieldAddresses((await launchBySymbol("MRDN")).baseMint).zMint;
    expect((await phx.simulateAndExplain(conn, await phx.buildCreateShieldTx(conn, user, zMint))).errorCode?.name).toBe("UnsupportedExtension");
  });

  it("derives shield PDAs with the shield program", () => {
    const mint = Keypair.generate().publicKey;
    const a = phx.shieldAddresses(mint);
    const ids = [a.shield, a.authority, a.zMint].map((k: PublicKey) => k.toBase58());
    expect(new Set(ids).size).toBe(3);
    expect(a.shield.equals(PublicKey.findProgramAddressSync([new TextEncoder().encode("shield"), mint.toBytes()], phx.PROGRAM_IDS.shield)[0])).toBe(true);
  });
});

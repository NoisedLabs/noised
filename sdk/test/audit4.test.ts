/**
 * Audit round 4, the client fixes (SDK 0.9.0): every proof of concept of the
 * audit, inverted into a regression test, and the new guards around them.
 *
 * - ID-F1 (steer): an RPC that reports leaves as used never moves the leaf a
 *   message is signed at; used leaves this ledger does not know refuse BEFORE
 *   anything is reserved (`UnknownLeavesError`), and the leaf comes from the
 *   secret probe v2 (keyed by the identity's SEED), not the public probe.
 * - ID-F2b / ID-F3 (forged import): a record without a signature only marks
 *   its leaf taken; it never re-points a message that holds a live leaf.
 * - ID-F4 (pending race): "is an earlier signature pending, reserve, sign"
 *   runs under the launch's signing lock, so two concurrent calls never both
 *   sign; a leaf bit reported set never ends an unconfirmed signature.
 * - ID-F6 (postcheck): a plan whose message no longer matches the reviewed
 *   one is refused before any leaf is reserved.
 * - ID-F1b / ID-F5 (clock): a cluster clock that disagrees with this device's
 *   (or a second RPC's) by more than 120 s refuses before any signature; a
 *   freeze approval expires at most 24 hours after this device's clock.
 * - ID-F2 (caps): at most 3 signatures of one launch (attestations), or of
 *   one (launch, kind) (`pq_authorize`), that never landed with success,
 *   unless the user confirms (`acknowledgeExtraSignatures`).
 * - C1: an autopilot payee that could never receive its share (a PQ vault of
 *   another mint) is refused when the graph is planned or published.
 * - M4: a keeper never pays for recipients' wSOL accounts; a distribution
 *   nobody can receive is not run (`NoRecipientAccount`).
 * - A4-S: `activeActivation` rebuilds the running graph's approval from
 *   `active_auth` and `active_activate_at`.
 */
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { fromHex, toHex } from "../src/codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, KNOWN_ACCOUNTS, PROGRAM_IDS, WSOL_MINT } from "../src/constants.js";
import { activeActivation, decodeAutopilot } from "../src/autopilot/accounts.js";
import { buildPublishGraphTx, buildRunTx } from "../src/autopilot/builders.js";
import { planGraphActivation } from "../src/autopilot/flow.js";
import { planFreeze } from "../src/autopilot/freeze.js";
import { planKeeperStep, runKeeper } from "../src/autopilot/keeper.js";
import { checkGraphRecipients } from "../src/launch/recipients.js";
import { buildPlannedAttestTx, type LaunchPlan } from "../src/launch/flow.js";
import { unixToIso, unixToUtcText } from "../src/launch/window.js";
import { associatedTokenAddress, authorizationAddress, autopilotAddress, autopilotPdas, dammV2PoolAddress, graphRecordAddress, identityAddress, vaultAddress } from "../src/pda.js";
import { buildAttestLaunchTx, findPendingAttestations, PendingAttestationError, type BuildAttestLaunchArgs, type LaunchWindow } from "../src/pq/attest.js";
import { buildPqAuthorizeTx, type BuildPqAuthorizeArgs } from "../src/pq/authorize.js";
import { attestationMessage, deriveIdentity, leafProbeStart, type PqIdentity } from "../src/pq/identity.js";
import { deriveVaultKey } from "../src/pq/keys.js";
import { createMemoryLeafLedger, launchSignatures, type LeafLedger } from "../src/pq/leafLedger.js";
import { MAX_UNLANDED_SIGNATURES, SignatureCapError, signingLockName } from "../src/pq/signGuard.js";
import { activationPayload, freezePayload, revokePayload } from "../src/programmable/autopilot/logic.js";
import { burn, compileGraph, distributeSol, every, graph, graphHash } from "../src/programmable/index.js";
import { checkClockSkew, ClockSkewError, CLOCK_SKEW_MAX_SECS } from "../src/rpc/clock.js";
import { AttestConnection, bitmapOf, emulateAttestLaunch, identityAccountBytes } from "./attest_world.js";
import { key, readJson, tokenAccountBytes } from "./helpers.js";
import { accountBytes, clock, NOW, world, zeroed } from "./world.js";

// ------------------------------------------------------------ fixtures ---

const lms = readJson<{
  derivation: { master: string };
  attestation: { launch: string; creator: string; paramsHash: string; metadataHash: string; landsAt: number };
  accounts: { launch: { data: string }; tokenMeta: { address: string; data: string } };
}>("./vectors/lms.json");
const LAUNCH = new PublicKey(lms.attestation.launch);
const CREATOR = new PublicKey(lms.attestation.creator);
const LANDS_AT = BigInt(lms.attestation.landsAt);
const HASH = fromHex(lms.attestation.metadataHash);
const PARAMS = fromHex(lms.attestation.paramsHash);
const MASTER = fromHex(lms.derivation.master);

const W1: LaunchWindow = { notBefore: LANDS_AT + 600n, notAfter: LANDS_AT + 4_200n };
const W2: LaunchWindow = { notBefore: LANDS_AT + 5n * 86_400n, notAfter: LANDS_AT + 5n * 86_400n + 3_600n };
const W6: LaunchWindow = { notBefore: LANDS_AT + 6n * 86_400n, notAfter: LANDS_AT + 6n * 86_400n + 3_600n };

/** The vector launch (Configured, names identity 0 of lms.json) and its metadata record, attest_launch landing through the model. */
function attestWorld(at: bigint = LANDS_AT): AttestConnection {
  const conn = new AttestConnection();
  conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: fromHex(lms.accounts.launch.data) });
  conn.set(new PublicKey(lms.accounts.tokenMeta.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(lms.accounts.tokenMeta.data) });
  conn.setClock(at);
  conn.land = (w) => emulateAttestLaunch(conn, w);
  return conn;
}

/** An `Autopilot` account: every field zero or empty unless given (no graph, no operator, nothing recorded). */
function autopilotBytes(over: Record<string, unknown>): Uint8Array {
  return accountBytes("autopilot", "Autopilot", {
    version: 1,
    bump: 255,
    treasuryBump: 254,
    launch: PublicKey.default,
    mint: PublicKey.default,
    dammPool: PublicKey.default,
    activeGraph: new Uint8Array(32),
    pendingGraph: new Uint8Array(32),
    pendingActivateAt: 0n,
    pendingOperator: PublicKey.default,
    activatedAt: 0n,
    frozen: false,
    operator: PublicKey.default,
    authMarks: [0, 1, 2].map(() => ({ slot: 0n, key: PublicKey.default })),
    seq: 0n,
    refSqrtPrice: 1n << 59n,
    refUpdatedAt: 0n,
    refAllowance: 0n,
    refAllowanceAt: 0n,
    observations: [0, 1].map(() => ({ index: 0n, firstAt: 0n, min: 0n, max: 0n })),
    tipEpochStart: 0n,
    tipsInEpoch: 0n,
    nodes: Array.from({ length: 16 }, () => ({ lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n })),
    ...over,
  });
}

let id0: PqIdentity;
beforeAll(async () => {
  id0 = await deriveIdentity(MASTER, "localnet", 0);
});

const attestArgs = (ledger: LeafLedger, window: LaunchWindow, identity: PqIdentity = id0, over: Partial<BuildAttestLaunchArgs> = {}): BuildAttestLaunchArgs =>
  ({ launch: LAUNCH, creator: CREATOR, identity, ledger, metadataHash: HASH, window, payer: Keypair.generate(), allowLocalnet: true, expectedParamsHash: PARAMS, ...over }) as BuildAttestLaunchArgs;

type SDK = {
  attest: typeof import("../src/pq/attest.js");
  identity: typeof import("../src/pq/identity.js");
  ledger: typeof import("../src/pq/leafLedger.js");
  lms: typeof import("../src/pq/lms.js");
};

/** A fresh copy of the SDK modules: another device, or this one after its storage was cleared (a fresh in-process guard). */
async function otherDevice(): Promise<SDK> {
  vi.resetModules();
  // Its clock module is fresh too: this device's clock is the simulated cluster's (test/setup.ts).
  (await import("../src/rpc/clock.js")).setLocalClockSource(() => (globalThis as { __noisedMockClock?: bigint }).__noisedMockClock ?? null);
  return {
    attest: await import("../src/pq/attest.js"),
    identity: await import("../src/pq/identity.js"),
    ledger: await import("../src/pq/leafLedger.js"),
    lms: await import("../src/pq/lms.js"),
  };
}

// --------------------------------------------------------------- ID-F1 ---

describe("ID-F1: an RPC cannot steer the leaf (poc_identity_steer, inverted)", () => {
  it("device A, told every leaf but the one of device B's withheld signature is used, refuses before reserving anything; the RPC's bits never move its leaf", async () => {
    // Device B signs a window; the RPC (or relayer) keeps the bytes and never lands them.
    const B = await otherDevice();
    const idB = await B.identity.deriveIdentity(MASTER, "localnet", 0);
    const connB = attestWorld();
    connB.dropSends = true;
    const builtB = await B.attest.buildAttestLaunchTx(connB.asConnection(), attestArgs(B.ledger.createMemoryLeafLedger(), W6, idB) as never);
    if (builtB.status !== "ready") throw new Error("unreachable");
    const target = builtB.leaf;

    // Device A: same phrase, its own (empty) ledger. The RPC reports every leaf as used except B's.
    const A = await otherDevice();
    const idA = await A.identity.deriveIdentity(MASTER, "localnet", 0);
    const ledgerA = A.ledger.createMemoryLeafLedger();
    const connA = attestWorld();
    const fake: number[] = [];
    for (let q = 0; q < 1024; q++) if (q !== target) fake.push(q);
    connA.set(identityAddress(idA.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(idA.publicKey, bitmapOf(fake), 253) });
    const err = await A.attest.buildAttestLaunchTx(connA.asConnection(), attestArgs(ledgerA, W1, idA) as never).then(
      () => null,
      (e: unknown) => e as { name: string; unknownCount: number; usedOnChain: number; knownToLedger: number; chosenLeaf: number | null; message: string },
    );
    expect(err?.name).toBe("UnknownLeavesError");
    expect([err!.unknownCount, err!.usedOnChain, err!.knownToLedger]).toEqual([1_023, 1_023, 0]);
    expect(err!.message).toMatch(/^Nothing was signed: this quantum key was used elsewhere\. 1023 signatures on the chain are not in this device's records/);
    // Nothing reserved, nothing signed: no record at all, and certainly none at B's leaf.
    expect(await ledgerA.list(idA.identityId)).toEqual([]);
    // The leaf it would take is its own secret probe start (keyed by the identity's SEED), never the one the RPC left free.
    const msgA = A.identity.attestationMessage({ launch: LAUNCH, paramsHash: PARAMS, creator: CREATOR, metadataHash: HASH, ...W1 });
    expect(err!.chosenLeaf).toBe(idA.keyPair.leafProbeStart(msgA));
    expect(err!.chosenLeaf).not.toBe(target);

    // On the honest chain (nothing landed) device A signs at that secret start.
    const honest = attestWorld();
    const built = await A.attest.buildAttestLaunchTx(honest.asConnection(), attestArgs(ledgerA, W1, idA) as never);
    if (built.status !== "ready") throw new Error("unreachable");
    expect(built.leaf).toBe(idA.keyPair.leafProbeStart(msgA));
    expect(A.lms.lmsVerify(idA.publicKey, built.message, built.lmsSignature)).toBe(built.leaf);
  });

  it("the secret probe v2 is not the public probe: an RPC that knows the message and the public key cannot compute the leaf", () => {
    const msg = attestationMessage({ launch: LAUNCH, paramsHash: PARAMS, creator: CREATOR, metadataHash: HASH, ...W1 });
    const secret = id0.keyPair.leafProbeStart(msg);
    expect(Number.isInteger(secret) && secret >= 0 && secret < 1024).toBe(true);
    expect(secret).toBe(id0.keyPair.leafProbeStart(msg)); // deterministic per message
    // The public (v1) probe of SDK 0.8 and older, from I and the message only: kept for vectors, never used to choose.
    expect(leafProbeStart(id0.publicKey.subarray(8, 24), msg)).not.toBe(secret);
  });

  it("a forged 'other device' export with one unsigned record never re-points a message: the rebuild gives the same leaf and the same signature (variant without a lying RPC)", async () => {
    const B = await otherDevice();
    const idB = await B.identity.deriveIdentity(MASTER, "localnet", 0);
    const builtB = await B.attest.buildAttestLaunchTx(attestWorld().asConnection(), attestArgs(B.ledger.createMemoryLeafLedger(), W6, idB) as never);
    if (builtB.status !== "ready") throw new Error("unreachable");

    const A = await otherDevice();
    const idA = await A.identity.deriveIdentity(MASTER, "localnet", 0);
    const ledgerA = A.ledger.createMemoryLeafLedger();
    const connA = attestWorld();
    const first = await A.attest.buildAttestLaunchTx(connA.asConnection(), attestArgs(ledgerA, W1, idA) as never); // sent; the relayer withholds it
    if (first.status !== "ready") throw new Error("unreachable");
    expect(first.leaf).not.toBe(builtB.leaf);

    // The export passes importLeafRecords; its one unsigned record names A's message at B's leaf.
    const forged = {
      format: A.ledger.LEAF_LEDGER_EXPORT_FORMAT as typeof A.ledger.LEAF_LEDGER_EXPORT_FORMAT,
      identityId: toHex(idA.identityId),
      records: [
        {
          identityId: toHex(idA.identityId),
          leaf: builtB.leaf,
          messageHash: toHex(first.messageHash),
          status: "reserved" as const,
          launch: LAUNCH.toBase58(),
          message: null,
          signature: null,
          landedSlot: null,
          attested: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    expect((await A.ledger.importLeafRecords(ledgerA, idA.publicKey, forged)).added).toBe(1);
    // It only marked B's leaf taken (burned, no message); A's message still holds its own leaf.
    const atB = (await ledgerA.list(idA.identityId)).find((r) => r.leaf === builtB.leaf)!;
    expect([atB.status, atB.message, atB.signature]).toEqual(["burned", null, null]);
    expect((await ledgerA.findByMessage(idA.identityId, first.messageHash))?.leaf).toBe(first.leaf);

    // The app rebuilds "with the same inputs": the recorded signature again, never a new one at B's leaf.
    const again = await A.attest.buildAttestLaunchTx(connA.asConnection(), attestArgs(ledgerA, W1, idA) as never);
    if (again.status !== "ready") throw new Error("unreachable");
    expect([again.leaf, again.retry, toHex(again.lmsSignature)]).toEqual([first.leaf, true, toHex(first.lmsSignature)]);
  });
});

// --------------------------------------------------------------- ID-F4 ---

describe("ID-F4: one signer at a time per launch (poc_identity_pending_race, inverted)", () => {
  it("sequentially, the second window is refused", async () => {
    const conn = attestWorld();
    const ledger = createMemoryLeafLedger();
    expect((await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, W1))).status).toBe("ready");
    await expect(buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, W2))).rejects.toBeInstanceOf(PendingAttestationError);
  });

  it("concurrently (a double click, two tabs, a retry loop), exactly one window is signed and the other refused", async () => {
    const conn = attestWorld();
    const ledger = createMemoryLeafLedger();
    const settled = await Promise.allSettled([buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, W1)), buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, W2))]);
    const ready = settled.filter((s) => s.status === "fulfilled" && s.value.status === "ready");
    const refused = settled.filter((s) => s.status === "rejected" && s.reason instanceof PendingAttestationError);
    expect([ready.length, refused.length]).toEqual([1, 1]);
    expect(await findPendingAttestations(conn.asConnection(), { launch: LAUNCH, lmsPublicKey: id0.publicKey, ledger })).toHaveLength(1);
    expect(await launchSignatures(ledger, id0.identityId, LAUNCH)).toHaveLength(1);
  });

  it("the signing lock is named after the launch and a caller's lock (navigator.locks in a browser) is used", async () => {
    const names: string[] = [];
    const lock = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      names.push(name);
      return fn();
    };
    const built = await buildAttestLaunchTx(attestWorld().asConnection(), attestArgs(createMemoryLeafLedger(), W1, id0, { signingLock: lock }));
    expect(built.status).toBe("ready");
    // Taken under its name from before the rename to Noised first (earlier clients take that one), then its own.
    expect(names).toEqual([`phalanx/pq/sign/v1/${LAUNCH.toBase58()}`, signingLockName(LAUNCH)]);
    expect(signingLockName(LAUNCH)).toBe(`noised/pq/sign/v1/${LAUNCH.toBase58()}`);
  });

  it("a lying RPC cannot end a withheld signature's pending state: not with its leaf reported used, not with a clock past its window", async () => {
    const conn = attestWorld();
    const ledger = createMemoryLeafLedger();
    const old = await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, W2)); // sent, withheld by the RPC
    if (old.status !== "ready") throw new Error("unreachable");
    // (a) a fake bit at the withheld signature's leaf: still pending (a set bit alone is no landing with a known outcome).
    conn.set(identityAddress(id0.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(id0.publicKey, bitmapOf([old.leaf]), 253) });
    const refused = await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, W1)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(PendingAttestationError);
    expect((refused as PendingAttestationError).pending.map((p) => [p.leaf, p.leafSetOnChain])).toEqual([[old.leaf, true]]);
    // (b) a clock past its window: this device's clock disagrees, nothing is signed.
    const ahead = attestWorld(W2.notAfter + 10n);
    ahead.set(identityAddress(id0.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(id0.publicKey, bitmapOf([]), 253) });
    await expect(buildAttestLaunchTx(ahead.asConnection(), attestArgs(ledger, W1, id0, { localNowSecs: LANDS_AT }))).rejects.toBeInstanceOf(ClockSkewError);
    expect(await launchSignatures(ledger, id0.identityId, LAUNCH)).toHaveLength(1);
  });
});

// --------------------------------------------------------------- ID-F6 ---

describe("ID-F6: the reviewed message is compared before anything is reserved (poc_identity_postcheck, inverted)", () => {
  it("a plan whose window no longer matches its reviewed message is refused with no reservation, no signature, nothing pending", async () => {
    const conn = attestWorld();
    const base = { launch: LAUNCH, paramsHash: PARAMS, creator: CREATOR, metadataHash: HASH };
    const message = attestationMessage({ ...base, ...W1 });
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const plan = {
      creator: CREATOR,
      launch: LAUNCH,
      paramsHash: PARAMS,
      metadataHash: HASH,
      rulesHash: new Uint8Array(32),
      window: { ...W1 },
      pqIdentity: id0.identityId,
      message,
      messageHash: sha256(message),
    } as unknown as LaunchPlan;
    // The app moves the opening time in place (or loads a stale copy): message and messageHash are what was shown.
    (plan.window as { notBefore: bigint; notAfter: bigint }).notBefore = W2.notBefore;
    (plan.window as { notBefore: bigint; notAfter: bigint }).notAfter = W2.notAfter;
    const ledger = createMemoryLeafLedger();
    await expect(buildPlannedAttestTx(conn.asConnection(), plan, { identity: id0, ledger, payer: Keypair.generate(), allowLocalnet: true })).rejects.toThrow(
      /refusing to sign: the message built from the chain and these inputs differs from the one reviewed \(expectedMessageHash\)/,
    );
    expect(await ledger.list(id0.identityId)).toEqual([]);
    expect(await launchSignatures(ledger, id0.identityId, LAUNCH)).toEqual([]);
    expect(await findPendingAttestations(conn.asConnection(), { launch: LAUNCH, lmsPublicKey: id0.publicKey, ledger })).toEqual([]);
  });
});

// ---------------------------------------------------- ID-F1b / ID-F5 ---

describe("ID-F1b: clock sanity before the identity signs a time", () => {
  it("checkClockSkew: within 120 s passes; past it, or a second RPC that disagrees, throws ClockSkewError with a plain message", async () => {
    const conn = attestWorld();
    expect(CLOCK_SKEW_MAX_SECS).toBe(120n);
    expect(await checkClockSkew(conn.asConnection(), { localNowSecs: LANDS_AT + 120n })).toEqual({ localSecs: LANDS_AT + 120n, clusterSecs: LANDS_AT, secondClusterSecs: null, skewSecs: 120n });
    const e = await checkClockSkew(conn.asConnection(), { localNowSecs: LANDS_AT - 121n }).then(
      () => null,
      (x: unknown) => x as ClockSkewError,
    );
    expect(e).toBeInstanceOf(ClockSkewError);
    expect([e!.skewSecs, e!.maxSkewSecs, e!.clusterSecs, e!.localSecs]).toEqual([121n, 120n, LANDS_AT, LANDS_AT - 121n]);
    expect(e!.message).toMatch(/^Nothing was signed: your RPC's clock \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\) and this device's clock \(.*\) differ by 121 seconds \(at most 120 allowed\)\. A wrong clock could make your quantum key sign a time you did not choose\./);
    // Device and RPC agree (both wrong by a year), a second RPC does not.
    const liar = attestWorld(LANDS_AT + 365n * 86_400n);
    const second = await checkClockSkew(liar.asConnection(), { localNowSecs: LANDS_AT + 365n * 86_400n, secondConnection: attestWorld().asConnection() }).then(
      () => null,
      (x: unknown) => x as ClockSkewError,
    );
    expect([second?.secondClusterSecs, second?.skewSecs]).toEqual([LANDS_AT, 365n * 86_400n]);
    expect(second!.message).toContain("a second RPC's");
    await expect(checkClockSkew(conn.asConnection(), { maxClockSkewSecs: -1n })).rejects.toThrow(RangeError);
    await expect(checkClockSkew(conn.asConnection(), { localNowSecs: 1 as unknown as bigint })).rejects.toThrow(TypeError);
  });

  it("an attestation is refused before anything is reserved when the clocks disagree, and signed when they agree within 120 s", async () => {
    const ledger = createMemoryLeafLedger();
    await expect(buildAttestLaunchTx(attestWorld().asConnection(), attestArgs(ledger, W1, id0, { localNowSecs: LANDS_AT + 121n }))).rejects.toBeInstanceOf(ClockSkewError);
    await expect(
      buildAttestLaunchTx(attestWorld().asConnection(), attestArgs(ledger, W1, id0, { secondConnection: attestWorld(LANDS_AT + 3_600n).asConnection() })),
    ).rejects.toBeInstanceOf(ClockSkewError);
    expect(await ledger.list(id0.identityId)).toEqual([]);
    const ok = await buildAttestLaunchTx(attestWorld().asConnection(), attestArgs(ledger, W1, id0, { localNowSecs: LANDS_AT + 120n }));
    expect(ok.status).toBe("ready");
    // Every time it signs is shown as an absolute date too.
    expect(ok.windowIso).toEqual({ notBefore: unixToIso(W1.notBefore), notAfter: unixToIso(W1.notAfter) });
  });
});

describe("ID-F5: a lying RPC clock cannot turn a 1-hour freeze into a 1-year one (poc_identity_freeze_clock, inverted)", () => {
  const YEAR = 365n * 86_400n;
  const real = BigInt(NOW);
  const G1 = compileGraph(graph().node("burn", every("1d"), null, burn(1_000)).build());
  const H1 = graphHash(G1);

  function freezeWorld(clockAt: bigint): { conn: AttestConnection; launch: PublicKey; creator: PublicKey; ap: PublicKey } {
    const w = world();
    w.launchState["pqIdentity"] = id0.identityId;
    w.build();
    const conn = new AttestConnection();
    for (const [k, a] of w.conn.accounts) conn.accounts.set(k, a);
    const p = autopilotPdas(w.launch, w.mint);
    conn.set(p.autopilot, {
      owner: PROGRAM_IDS.autopilot,
      data: autopilotBytes({ version: 1, bump: 255, treasuryBump: 254, launch: w.launch, mint: w.mint, activeGraph: H1, activatedAt: real - 86_400n }),
    });
    conn.setClock(clockAt);
    return { conn, launch: w.launch, creator: w.launchState["creator"] as PublicKey, ap: p.autopilot };
  }

  it("planFreeze refuses a cluster clock a year ahead of this device's (or of a second RPC's)", async () => {
    const liar = freezeWorld(real + YEAR);
    await expect(planFreeze(liar.conn.asConnection(), liar.launch, { localNowSecs: real })).rejects.toBeInstanceOf(ClockSkewError);
    const honest = freezeWorld(real);
    await expect(planFreeze(liar.conn.asConnection(), liar.launch, { localNowSecs: real + YEAR, secondConnection: honest.conn.asConnection() })).rejects.toBeInstanceOf(ClockSkewError);
    // Honest clocks: the default hour, shown as an absolute date.
    const plan = await planFreeze(honest.conn.asConnection(), honest.launch, { localNowSecs: real });
    expect([plan.notAfter, plan.notAfterIso]).toEqual([real + 3_600n, unixToIso(real + 3_600n)]);
  });

  it("a freeze expires at most 24 hours after this device's clock, in the plan and in the approval the identity signs", async () => {
    const t = freezeWorld(real);
    expect((await planFreeze(t.conn.asConnection(), t.launch, { notAfter: real + 86_400n })).notAfter).toBe(real + 86_400n);
    await expect(planFreeze(t.conn.asConnection(), t.launch, { notAfter: real + 86_401n })).rejects.toThrow(/more than 24 hours after this device's clock/);
    await expect(planFreeze(t.conn.asConnection(), t.launch, { validForSecs: 86_401n })).rejects.toThrow(RangeError);
    // buildPqAuthorizeTx refuses a longer freeze too, before anything is reserved.
    const notAfter = real + 2n * 86_400n;
    const ledger = createMemoryLeafLedger();
    await expect(
      buildPqAuthorizeTx(t.conn.asConnection(), {
        launch: t.launch,
        creator: t.creator,
        identity: id0,
        ledger,
        kind: 2,
        payloadHash: freezePayload(t.ap, H1, notAfter),
        freezeNotAfter: notAfter,
        allowLocalnet: true,
      }),
    ).rejects.toThrow(/more than 24 hours from now/);
    expect(await ledger.list(id0.identityId)).toEqual([]);
  });
});

// --------------------------------------------------------------- ID-F2 ---

describe("ID-F2: at most 3 signatures that never landed per launch (and per approval kind)", () => {
  it("attestations: a fourth window after three that never landed needs acknowledgeExtraSignatures; nothing is reserved without it", async () => {
    expect(MAX_UNLANDED_SIGNATURES).toBe(3);
    const conn = attestWorld();
    const ledger = createMemoryLeafLedger();
    let t = LANDS_AT;
    const leaves: number[] = [];
    // Each window signed, never landed (dropped), then passed on both clocks: no longer pending, still a live signature.
    for (let i = 0; i < 3; i++) {
      conn.setClock(t);
      const built = await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, { notBefore: t + 600n, notAfter: t + 4_200n }));
      if (built.status !== "ready") throw new Error("unreachable");
      leaves.push(built.leaf);
      t += 4_201n;
    }
    conn.setClock(t);
    const before = (await ledger.list(id0.identityId)).length;
    const next = { notBefore: t + 600n, notAfter: t + 4_200n };
    const e = await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, next)).then(
      () => null,
      (x: unknown) => x as SignatureCapError,
    );
    expect(e).toBeInstanceOf(SignatureCapError);
    expect([e!.what, e!.count, e!.max, [...e!.leaves].sort((a, b) => a - b)]).toEqual(["attestation", 3, 3, [...leaves].sort((a, b) => a - b)]);
    expect(e!.message).toMatch(/^Nothing was signed: 3 earlier launch signatures for this launch were signed but never landed with success/);
    expect((await ledger.list(id0.identityId)).length).toBe(before);
    // The user confirmed: one more.
    expect((await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, next, id0, { acknowledgeExtraSignatures: true }))).status).toBe("ready");
  });

  it("pq_authorize: three plan approvals that never landed cap that kind for the launch; other kinds are counted apart", async () => {
    const w = world();
    w.launchState["pqIdentity"] = id0.identityId;
    w.build();
    const conn = new AttestConnection();
    for (const [k, a] of w.conn.accounts) conn.accounts.set(k, a);
    const ap = autopilotAddress(w.launch);
    const H = graphHash(compileGraph(graph().node("burn", every("1d"), null, burn(1_000)).build()));
    const operator = key("a4/cap/operator");
    const activeAuth = authorizationAddress(w.launch, 1, activationPayload(ap, H, BigInt(NOW)));
    conn.set(ap, {
      owner: PROGRAM_IDS.autopilot,
      data: autopilotBytes({ version: 1, bump: 255, treasuryBump: 254, launch: w.launch, mint: w.mint, activeGraph: H, activatedAt: BigInt(NOW), operator, activeAuth, activeActivateAt: BigInt(NOW) }),
    });
    conn.setClock(BigInt(NOW));
    const ledger = createMemoryLeafLedger();
    const base = { launch: w.launch, creator: w.launchState["creator"] as PublicKey, identity: id0, ledger, allowLocalnet: true } as const;
    const activate = (i: number, over: Partial<BuildPqAuthorizeArgs> = {}) =>
      buildPqAuthorizeTx(conn.asConnection(), { ...base, kind: 1, payloadHash: activationPayload(ap, H, BigInt(NOW) + 400_000n + BigInt(i)), ...over });
    for (let i = 0; i < 3; i++) expect((await activate(i)).status).toBe("ready");
    const e = await activate(3).then(
      () => null,
      (x: unknown) => x as SignatureCapError,
    );
    expect([e?.name, e?.what, e?.count]).toEqual(["SignatureCapError", 1, 3]);
    expect(e!.message).toMatch(/3 earlier plan approvals for this launch/);
    // A rebuild of a recorded approval makes no new signature and is never refused.
    const rebuilt = await activate(0);
    expect(rebuilt.status === "ready" && rebuilt.retry).toBe(true);
    // Another kind (removing the operator) is counted apart.
    expect((await buildPqAuthorizeTx(conn.asConnection(), { ...base, kind: 3, payloadHash: revokePayload(ap, H, operator, activeAuth) })).status).toBe("ready");
    expect((await activate(3, { acknowledgeExtraSignatures: true })).status).toBe("ready");
  });
});

// ------------------------------------------------------------------ C1 ---

describe("C1: an autopilot payee that could never receive its share is refused (poc_custody_autopilot_recipient, inverted)", () => {
  function c1World(): { conn: AttestConnection; launch: PublicKey; mint: PublicKey; vault: PublicKey } {
    const w = world();
    w.build();
    const conn = new AttestConnection();
    for (const [k, a] of w.conn.accounts) conn.accounts.set(k, a);
    // A v4 PQ vault of the launch's own token (it only ever releases that mint).
    const k = deriveVaultKey(new Uint8Array(64).fill(7), "localnet", w.mint, 0, 0);
    const vault = vaultAddress(w.mint, k.keyId);
    conn.set(vault, {
      owner: PROGRAM_IDS.vault,
      data: accountBytes("vault", "Vault", { version: 4, bump: 255, mint: w.mint, genesisKeyId: k.keyId, sequence: 0n, keyId: k.keyId, keyIdent: k.pk.id, keyQ: 0, keyK: k.pk.k, reserved: 0n }),
    });
    const p = autopilotPdas(w.launch, w.mint);
    conn.set(p.autopilot, { owner: PROGRAM_IDS.autopilot, data: autopilotBytes({ version: 1, bump: 255, treasuryBump: 254, launch: w.launch, mint: w.mint }) });
    conn.setClock(BigInt(NOW));
    return { conn, launch: w.launch, mint: w.mint, vault };
  }

  it("planGraphActivation and both publish builders refuse a graph paying a PQ vault of another mint; nothing is approved", async () => {
    const t = c1World();
    const G = compileGraph(graph().recipient(t.vault, "100%").node("share", every("1d"), null, distributeSol(1)).build());
    const check = await checkGraphRecipients(t.conn.asConnection(), [t.vault]);
    expect(check.ok).toBe(false);
    expect(check.refusals.join(" ")).toMatch(new RegExp(`^recipients\\[0\\] \\(${t.vault.toBase58()}\\): .*PQ vault of another mint`));
    await expect(planGraphActivation(t.conn.asConnection(), t.launch, G)).rejects.toThrow(/refusing to plan this graph: a payee could never receive its share:\nrecipients\[0\]/);
    await expect(buildPublishGraphTx(t.conn.asConnection(), key("a4/c1/payer"), t.launch, G)).rejects.toThrow(/refusing to publish this graph: a payee could never receive its share/);
  });

  it("a wallet payee without a wSOL account yet is a caution (it is skipped until it opens one), not a refusal", async () => {
    const t = c1World();
    const wallet = key("a4/c1/wallet");
    const check = await checkGraphRecipients(t.conn.asConnection(), [wallet]);
    expect(check.ok).toBe(true);
    expect(check.withoutAccount.map((k) => k.toBase58())).toEqual([wallet.toBase58()]);
    expect(check.warnings.join(" ")).toMatch(/^recipients\[0\]/);
    // With its wSOL account: nothing to say.
    t.conn.set(associatedTokenAddress(wallet, WSOL_MINT, KNOWN_ACCOUNTS.splToken), { owner: KNOWN_ACCOUNTS.splToken, data: tokenAccountBytes({ mint: WSOL_MINT, owner: wallet, amount: 0n }) });
    const ok = await checkGraphRecipients(t.conn.asConnection(), [wallet]);
    expect([ok.ok, ok.withoutAccount, ok.warnings]).toEqual([true, [], []]);
    const plan = await planGraphActivation(t.conn.asConnection(), t.launch, compileGraph(graph().recipient(wallet, "100%").node("share", every("1d"), null, distributeSol(1)).build()));
    expect(plan.warnings).toEqual([]);
  });
});

// ------------------------------------------------------------------ M4 ---

describe("M4: a keeper never funds recipients' accounts (audit4_custody_keeper, inverted)", () => {
  const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const SPL = KNOWN_ACCOUNTS.splToken;
  const T22 = KNOWN_ACCOUNTS.token2022;
  const SOL = 1_000_000_000n;
  const REF = 1n << 59n;

  function attackWorld(n: number): { conn: ReturnType<typeof world>["conn"]; launch: PublicKey; recipients: PublicKey[] } {
    const w = world();
    const recipients = Array.from({ length: n }, (_, i) => key(`evil/recipient/${i}`));
    let b = graph();
    const share = Math.floor(100 / n);
    recipients.forEach((r, i) => (b = b.recipient(r.toBase58(), `${i === n - 1 ? 100 - share * (n - 1) : share}%`)));
    const G = compileGraph(b.node("drip", every("10m"), null, distributeSol(0.001), { maxRunsPerEpoch: 6 }).build());
    const H = graphHash(G);
    const p = autopilotPdas(w.launch, w.mint);
    const pool = dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, w.mint, WSOL_MINT);
    w.conn.set(p.autopilot, {
      owner: PROGRAM_IDS.autopilot,
      data: autopilotBytes({ version: 1, bump: 255, treasuryBump: 254, launch: w.launch, mint: w.mint, dammPool: pool, activeGraph: H, activatedAt: BigInt(NOW - 86_400), refSqrtPrice: REF }),
    });
    w.conn.set(graphRecordAddress(w.launch, H), { owner: PROGRAM_IDS.autopilot, data: accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch: w.launch, graphHash: H, bytes: G }) });
    w.conn.set(p.treasuryWsol, { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: p.treasury, amount: 1n * SOL }) });
    w.conn.set(p.treasuryToken!, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: p.treasury, amount: 0n, token2022: true }) });
    const poolState = zeroed("dammV2", "Pool");
    Object.assign(poolState, { tokenAMint: w.mint, tokenBMint: WSOL_MINT, tokenAVault: key("evil/va"), tokenBVault: key("evil/vb"), creator: KNOWN_ACCOUNTS.dbcPoolAuthority, sqrtPrice: REF });
    w.conn.set(pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", poolState) });
    w.conn.set(key("evil/vb"), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: KNOWN_ACCOUNTS.dammV2PoolAuthority, amount: 200n * SOL }) });
    w.conn.set(new PublicKey("SysvarC1ock11111111111111111111111111111111"), { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(NOW) });
    return { conn: w.conn, launch: w.launch, recipients };
  }

  /** Associated-token-account creations the caller pays for someone else. */
  const fundedForOthers = (tx: Transaction, payer: PublicKey): PublicKey[] =>
    tx.instructions.filter((ix) => ix.programId.equals(ATA) && ix.keys[0]!.pubkey.equals(payer) && !ix.keys[2]!.pubkey.equals(payer)).map((ix) => ix.keys[2]!.pubkey);

  it("recipients without wSOL accounts: no run is planned or built (NoRecipientAccount), whatever their number", async () => {
    const caller = key("keeper/bot");
    for (let n = 1; n <= 8; n++) {
      const t = attackWorld(n);
      const step = await planKeeperStep(t.conn.asConnection(), caller, t.launch);
      expect(step.kind, `n=${n}`).toBe("idle");
      expect(step.detail).toMatch(/Nothing could run now/);
      await expect(buildRunTx(t.conn.asConnection(), caller, t.launch, 0)).rejects.toThrow(/NoRecipientAccount/);
    }
  });

  it("one recipient with a wSOL account: the run pays it, skips the others (their shares stay in the treasury), funds no one's account and states its costs", async () => {
    const t = attackWorld(3);
    const r0 = t.recipients[0]!;
    t.conn.set(associatedTokenAddress(r0, WSOL_MINT, SPL), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: r0, amount: 0n }) });
    const caller = Keypair.fromSeed(new Uint8Array(32).fill(9));
    const step = await planKeeperStep(t.conn.asConnection(), caller.publicKey, t.launch);
    if (step.kind !== "run") throw new Error(`expected a run, got ${step.kind}: ${step.detail}`);
    expect(fundedForOthers(step.tx, caller.publicKey)).toEqual([]);
    expect(step.run.skippedRecipients.map((k) => k.toBase58())).toEqual([t.recipients[1]!.toBase58(), t.recipients[2]!.toBase58()]);
    // At most the rent of its own tip account (created once), never 2,039,280 lamports per recipient.
    expect(step.costs.rentLamports).toBeLessThanOrEqual(2_039_280n);
    expect(step.costs.totalLamports).toBe(step.costs.signatureFeeLamports + step.costs.priorityFeeLamports + step.costs.rentLamports);
    expect(step.detail).toMatch(/2 recipient\(s\) without a wSOL account are skipped/);
    const sent: Transaction[] = [];
    const r = await runKeeper(t.conn.asConnection(), {
      caller,
      launch: t.launch,
      maxSteps: 1,
      send: async (tx) => {
        sent.push(tx);
        return "sig";
      },
      sleep: async () => undefined,
    });
    expect(sent).toHaveLength(1);
    expect(fundedForOthers(sent[0]!, caller.publicKey)).toEqual([]);
    expect(r.costLamports).toBe(step.costs.totalLamports);
  });
});

// ---------------------------------------------------------------- A4-S ---

describe("A4-S: the running graph's approval from active_auth and active_activate_at", () => {
  it("activeActivation: the authorization address of activationPayload(autopilot, active graph, active_activate_at); null when none is recorded", () => {
    const launch = key("a4/s/launch");
    const ap = autopilotAddress(launch);
    const H = graphHash(compileGraph(graph().node("burn", every("1d"), null, burn(1_000)).build()));
    const at = 1_800_000_000n;
    const auth = authorizationAddress(launch, 1, activationPayload(ap, H, at));
    const bytes = (activeAuth: PublicKey, activeActivateAt: bigint): Uint8Array =>
      autopilotBytes({ version: 1, bump: 255, treasuryBump: 254, launch, activeGraph: H, activatedAt: at, activeAuth, activeActivateAt });
    const a = decodeAutopilot(ap, bytes(auth, at));
    expect([a.activeAuth.toBase58(), a.activeActivateAt, a.activeAuthOrNull?.toBase58()]).toEqual([auth.toBase58(), at, auth.toBase58()]);
    const act = activeActivation(a)!;
    expect([act.matches, act.authorization.toBase58(), toHex(act.payloadHash)]).toEqual([true, auth.toBase58(), toHex(activationPayload(ap, H, at))]);
    expect(activeActivation(decodeAutopilot(ap, bytes(auth, at + 1n)))!.matches).toBe(false);
    expect(activeActivation(decodeAutopilot(ap, bytes(PublicKey.default, 0n)))).toBeNull();
  });
});

describe("absolute dates in every plan and status", () => {
  it("unixToIso / unixToUtcText", () => {
    expect(unixToIso(0n)).toBe("1970-01-01T00:00:00Z");
    expect(unixToIso(1_800_000_000n)).toBe("2027-01-15T08:00:00Z");
    expect(unixToUtcText(1_800_000_000n)).toBe("2027-01-15 08:00 UTC");
    expect(unixToIso(-1n)).toBe("unix -1");
    expect(() => unixToIso(1 as unknown as bigint)).toThrow(TypeError);
  });
});

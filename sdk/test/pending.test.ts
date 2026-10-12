/**
 * Audit round 3, review info #2: older attestation signatures that were
 * sent but never landed can take a freed slot (F1 made an attestation whose
 * window passed unused replaceable). The SDK's mitigation, against the
 * vector launch of `vectors/lms.json` and the model of `attest_launch` in
 * `./attest_world.ts`:
 *
 * - the leaf ledger lists every (window, message hash) signed per launch,
 *   read from the signed bytes (`launchSignatures`);
 * - `buildAttestLaunchTx` refuses a NEW message while an earlier signature
 *   of the launch has not landed and its window has not ended
 *   (`PendingAttestationError`, nothing reserved or signed); a rebuild of a
 *   recorded signature is never refused; an ended window or a used leaf no
 *   longer counts;
 * - `landOrBurnPending` re-sends recorded signatures (never a new one):
 *   `burnOnly` while the current attestation holds the slot (they only burn,
 *   marked `retired`, not counted against the burn-only cap), or all of
 *   them (the first that can attest sets the window);
 * - `getLaunchFlowStatus` warns at `window-missed`, and with the ledger
 *   lists the pending signatures and when to retire them.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { fromHex, toHex } from "../src/codec/bytes.js";
import { PROGRAM_IDS } from "../src/constants.js";
import { getLaunchFlowStatus } from "../src/launch/flow.js";
import { attestationAddress, identityAddress } from "../src/pda.js";
import {
  AttestRetryLimitError,
  buildAttestLaunchTx,
  findPendingAttestations,
  fundingLamportsForPending,
  landOrBurnPending,
  PendingAttestationError,
  sendAttestLaunchTx,
  type AttestLaunchReady,
  type BuildAttestLaunchArgs,
  type LaunchWindow,
} from "../src/pq/attest.js";
import { attestationMessage, deriveIdentity, type PqIdentity } from "../src/pq/identity.js";
import {
  createLeafLedger,
  createMemoryLeafLedger,
  exportLeafRecords,
  importLeafRecords,
  launchSignatures,
  LeafLedgerError,
  memoryLeafLedgerStore,
  reserveAndSign,
  type LeafLedger,
} from "../src/pq/leafLedger.js";
import { AttestConnection, bitmapOf, emulateAttestLaunch, identityAccountBytes } from "./attest_world.js";
import { key, readJson } from "./helpers.js";

interface Vectors {
  derivation: { master: string };
  attestation: { launch: string; creator: string; paramsHash: string; metadataHash: string; notBefore: number; notAfter: number; landsAt: number };
  accounts: { launch: { data: string }; tokenMeta: { address: string; data: string } };
}
const v = readJson<Vectors>("./vectors/lms.json");
const LAUNCH = new PublicKey(v.attestation.launch);
const CREATOR = new PublicKey(v.attestation.creator);
const LANDS_AT = BigInt(v.attestation.landsAt);
const WINDOW: LaunchWindow = { notBefore: BigInt(v.attestation.notBefore), notAfter: BigInt(v.attestation.notAfter) };
const HASH = fromHex(v.attestation.metadataHash);
const RECORD = new PublicKey(v.accounts.tokenMeta.address);
const DAY = 86_400n;

let identity: PqIdentity;
beforeAll(async () => {
  identity = await deriveIdentity(fromHex(v.derivation.master), "localnet", 0);
});

/** The vector launch (Configured, names identity 0) at the vector's landing time, its record published; sends land through the program model. */
function world(): AttestConnection {
  const conn = new AttestConnection();
  conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.launch.data) });
  conn.set(RECORD, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.tokenMeta.data) });
  conn.setClock(LANDS_AT);
  conn.land = (w) => emulateAttestLaunch(conn, w);
  return conn;
}

function args(ledger: LeafLedger, window: LaunchWindow, over: Partial<BuildAttestLaunchArgs> = {}): BuildAttestLaunchArgs {
  return { launch: LAUNCH, creator: CREATOR, identity, ledger, metadataHash: HASH, window, payer: Keypair.generate(), allowLocalnet: true, expectedParamsHash: fromHex(v.attestation.paramsHash), ...over } as BuildAttestLaunchArgs;
}

const fund = (conn: AttestConnection, payer: PublicKey, lamports: bigint): void => {
  conn.set(payer, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(lamports) });
};

/** Sign `window` (the ledger records it) without sending: a signature that was revealed and never landed. */
async function signOnly(conn: AttestConnection, ledger: LeafLedger, window: LaunchWindow): Promise<AttestLaunchReady> {
  const r = await buildAttestLaunchTx(conn.asConnection(), args(ledger, window));
  expect(r.status).toBe("ready");
  return r as AttestLaunchReady;
}

/** Sign and land `window`; returns the built transaction. */
async function attest(conn: AttestConnection, ledger: LeafLedger, window: LaunchWindow): Promise<AttestLaunchReady> {
  const r = await signOnly(conn, ledger, window);
  fund(conn, r.payer.publicKey, r.fundingLamports);
  expect((await sendAttestLaunchTx(conn.asConnection(), r, { ledger })).status).toBe("attested");
  return r;
}

/**
 * A signature an earlier SDK (0.4.0) let the creator make while another one
 * was pending: the leaf ledger's own signer, at `leaf`, for `window`.
 */
async function legacySignature(ledger: LeafLedger, leaf: number, window: LaunchWindow): Promise<Uint8Array> {
  const message = attestationMessage({ launch: LAUNCH, paramsHash: fromHex(v.attestation.paramsHash), creator: CREATOR, metadataHash: HASH, ...window });
  await reserveAndSign(ledger, identity.keyPair, leaf, message, { launch: LAUNCH });
  return sha256(message);
}

const far: LaunchWindow = { notBefore: LANDS_AT + 6n * DAY, notAfter: LANDS_AT + 6n * DAY + 3_600n };

describe("the leaf ledger records every signed window per launch", () => {
  it("launchSignatures: each signature of the launch with its window and message hash, read from the signed bytes; other launches' are not listed", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const first = await attest(conn, ledger, WINDOW);
    conn.setClock(WINDOW.notAfter + 1n); // the window passed unused
    const next = { notBefore: WINDOW.notAfter + 600n, notAfter: WINDOW.notAfter + 4_200n };
    const second = await signOnly(conn, ledger, next);
    const other = attestationMessage({ launch: key("pending/other-launch"), paramsHash: new Uint8Array(32), creator: CREATOR, metadataHash: HASH, notBefore: 1n, notAfter: 61n });
    await reserveAndSign(ledger, identity.keyPair, 3, other);
    const sigs = await launchSignatures(ledger, identity.identityId, LAUNCH);
    expect(sigs.map((s) => [s.leaf, s.window.notBefore, s.window.notAfter, toHex(s.messageHash), s.record.status])).toEqual([
      [first.leaf, WINDOW.notBefore, WINDOW.notAfter, toHex(first.messageHash), "landed"],
      [second.leaf, next.notBefore, next.notAfter, toHex(second.messageHash), "signed"],
    ]);
    expect(toHex(sigs[1]!.signature)).toBe(toHex(second.lmsSignature));
    expect(toHex(sigs[1]!.metadataHash)).toBe(toHex(HASH));
    expect(await launchSignatures(ledger, identity.identityId, key("pending/other-launch"))).toHaveLength(1);
    await expect(launchSignatures(ledger, identity.identityId, "x" as unknown as PublicKey)).rejects.toThrow(TypeError);
  });
});

describe("buildAttestLaunchTx refuses a new window while an earlier signature can still land", () => {
  it("the review's case: a window signed and dropped, then another window: refused before anything is reserved or signed", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const a = await signOnly(conn, ledger, far); // sent, dropped: anyone holding it can land it later
    const before = await ledger.list(identity.identityId);
    const e = await buildAttestLaunchTx(conn.asConnection(), args(ledger, WINDOW)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PendingAttestationError);
    const err = e as PendingAttestationError;
    expect(err.launch.equals(LAUNCH)).toBe(true);
    expect(err.pending.map((p) => [p.leaf, p.window.notBefore, p.window.notAfter, p.landingNow])).toEqual([[a.leaf, far.notBefore, far.notAfter, "attests"]]);
    expect(err.message).toMatch(/never seen landing.*landOrBurnPending/s);
    expect(await ledger.list(identity.identityId)).toEqual(before);
    // A rebuild of the recorded signature (same window) is not a new signature: allowed, same bytes.
    const again = await signOnly(conn, ledger, far);
    expect([again.leaf, toHex(again.lmsSignature), again.retry]).toEqual([a.leaf, toHex(a.lmsSignature), true]);
  });

  it("a window about to end still counts through its last second (not_after inclusive), then no longer", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const soon = { notBefore: LANDS_AT - 1_000n, notAfter: LANDS_AT + 600n }; // 10 minutes left
    await signOnly(conn, ledger, soon);
    const next = { notBefore: LANDS_AT + 700n, notAfter: LANDS_AT + 4_300n };
    await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, next))).rejects.toBeInstanceOf(PendingAttestationError);
    conn.setClock(soon.notAfter);
    await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, next))).rejects.toBeInstanceOf(PendingAttestationError);
    conn.setClock(soon.notAfter + 1n);
    expect((await buildAttestLaunchTx(conn.asConnection(), args(ledger, next))).status).toBe("ready");
  });

  it("a rebuild of a recorded signature is allowed even while another older one is pending (it makes no new signature)", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const b = { notBefore: LANDS_AT + 1_200n, notAfter: LANDS_AT + 4_800n };
    await legacySignature(ledger, 30, far);
    const bHash = await legacySignature(ledger, 31, b); // two pending since 0.4.0
    const again = await buildAttestLaunchTx(conn.asConnection(), args(ledger, b));
    expect([again.status, again.leaf, toHex(again.messageHash)]).toEqual(["ready", 31, toHex(bHash)]);
    const e = await buildAttestLaunchTx(conn.asConnection(), args(ledger, WINDOW)).catch((x: unknown) => x);
    expect((e as PendingAttestationError).pending.map((p) => p.leaf).sort()).toEqual([30, 31]);
  });

  it("no longer counts once its window has ended (on both clocks), or once its landing is confirmed; a used bit alone never ends it (audit 4, ID-F4)", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const a = await signOnly(conn, ledger, WINDOW);
    conn.setClock(WINDOW.notAfter + 1n); // a's window ended: it can only burn a leaf now
    expect(await findPendingAttestations(conn.asConnection(), { launch: LAUNCH, lmsPublicKey: identity.publicKey, ledger })).toEqual([]);
    // ... unless this device's clock says it has not (an RPC whose clock runs ahead cannot end it early).
    expect(await findPendingAttestations(conn.asConnection(), { launch: LAUNCH, lmsPublicKey: identity.publicKey, ledger, localNowSecs: WINDOW.notAfter - 10n })).toHaveLength(1);
    expect((await signOnly(conn, ledger, { notBefore: WINDOW.notAfter + 600n, notAfter: WINDOW.notAfter + 4_200n })).leaf).not.toBe(a.leaf);

    const c2 = world();
    const l2 = createMemoryLeafLedger();
    const b = await signOnly(c2, l2, far);
    c2.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(identity.publicKey, bitmapOf([b.leaf]), 253) }); // it landed (unconfirmed)
    // The RPC that holds the signature could report that bit: it stays pending until its landing is confirmed.
    const e = await buildAttestLaunchTx(c2.asConnection(), args(l2, WINDOW)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PendingAttestationError);
    expect((e as PendingAttestationError).pending).toMatchObject([{ leaf: b.leaf, leafSetOnChain: true }]);
    // landOrBurnPending confirms it from the accounts (no send: its leaf is used) and retires it.
    const payer = Keypair.generate();
    const done = await landOrBurnPending(c2.asConnection(), { launch: LAUNCH, identity, ledger: l2, payer, allowLocalnet: true });
    expect(done.landings.map((l) => [l.leaf, l.outcome.status, l.signature])).toEqual([[b.leaf, "burned", null]]);
    expect(await l2.get(identity.identityId, b.leaf)).toMatchObject({ status: "landed", attested: false, retired: true });
    expect(done.remaining).toEqual([]);
    expect((await buildAttestLaunchTx(c2.asConnection(), args(l2, WINDOW))).status).toBe("ready");
  });
});

describe("landOrBurnPending", () => {
  it("burnOnly while the current attestation holds the slot: the older signature only burns its leaf (retired), the attestation is untouched, and the burn does not count against the cap", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const b = await attest(conn, ledger, WINDOW); // the current attestation
    const attested = Uint8Array.from(conn.get(attestationAddress(LAUNCH))!.data);
    const aHash = await legacySignature(ledger, 7, far); // pending since 0.4.0
    const pending = await findPendingAttestations(conn.asConnection(), { launch: LAUNCH, lmsPublicKey: identity.publicKey, ledger });
    expect(pending.map((p) => [p.leaf, p.landingNow])).toEqual([[7, "burns"]]);
    const status = await getLaunchFlowStatus(conn.asConnection(), LAUNCH, { pending: { ledger, lmsPublicKey: identity.publicKey } });
    expect([status.step, status.pendingSignatures?.length]).toEqual(["launch", 1]);
    expect(status.warnings).toEqual(["1 earlier signature for this launch never landed: retire them now, while they can only burn their leaf (landOrBurnPending with burnOnly)."]);

    const payer = Keypair.generate();
    const lamports = await fundingLamportsForPending(conn.asConnection(), { launch: LAUNCH, identity, ledger });
    expect(lamports).toBe(5_000n); // one landing; the identity and attestation exist
    fund(conn, payer.publicKey, lamports);
    const out = await landOrBurnPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, payer, burnOnly: true, allowLocalnet: true });
    expect(out.landings.map((l) => [l.leaf, l.outcome.status])).toEqual([[7, "burned"]]);
    expect(out.remaining).toEqual([]);
    expect(toHex(conn.get(attestationAddress(LAUNCH))!.data)).toBe(toHex(attested));
    expect(conn.get(payer.publicKey)?.lamports).toBe(0);
    const rec = await ledger.get(identity.identityId, 7);
    expect([rec?.status, rec?.attested, rec?.retired, rec?.messageHash]).toEqual(["landed", false, true, toHex(aHash)]);
    // Only re-sends: every landed signature is a recorded one.
    expect(conn.sent).toHaveLength(2);

    // The window passes unused: a new window is signed, and the retired burn does not count against a cap of 1.
    conn.setClock(WINDOW.notAfter + 1n);
    const next = { notBefore: WINDOW.notAfter + 600n, notAfter: WINDOW.notAfter + 4_200n };
    const c = await buildAttestLaunchTx(conn.asConnection(), args(ledger, next, { maxBurnOnlyLandings: 1 }));
    expect(c.status).toBe("ready");
    expect(b.leaf).not.toBe(7);
  });

  it("after the window passed: burnOnly leaves a signature that would attest (and a new window stays refused); without it, the creator's older window lands and attests", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    await attest(conn, ledger, WINDOW);
    const later = { notBefore: WINDOW.notAfter + 600n, notAfter: WINDOW.notAfter + 4_200n };
    const aHash = await legacySignature(ledger, 8, later);
    conn.setClock(WINDOW.notAfter + 1n); // the slot is free again
    const status = await getLaunchFlowStatus(conn.asConnection(), LAUNCH, { pending: { ledger, lmsPublicKey: identity.publicKey } });
    expect(status.step).toBe("window-missed");
    expect(status.pendingSignatures?.map((p) => p.landingNow)).toEqual(["attests"]);
    expect(status.warnings[0]).toMatch(/^1 earlier signature for this launch never landed and can still take its place/);

    const payer = Keypair.generate();
    fund(conn, payer.publicKey, 5_000n);
    const skipped = await landOrBurnPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, payer, burnOnly: true, allowLocalnet: true });
    expect(skipped.landings.map((l) => [l.leaf, l.outcome.status, l.signature])).toEqual([[8, "skipped", null]]);
    expect(skipped.remaining.map((p) => p.leaf)).toEqual([8]);
    const newer = { notBefore: WINDOW.notAfter + 1_200n, notAfter: WINDOW.notAfter + 4_800n };
    await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, newer))).rejects.toBeInstanceOf(PendingAttestationError);

    const out = await landOrBurnPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, payer, allowLocalnet: true });
    expect(out.landings.map((l) => [l.leaf, l.outcome.status])).toEqual([[8, "attested"]]);
    expect(toHex(conn.get(attestationAddress(LAUNCH))!.data.subarray(140, 172))).toBe(toHex(aHash));
    const rec = await ledger.get(identity.identityId, 8);
    expect([rec?.status, rec?.attested, rec?.retired]).toEqual(["landed", true, undefined]);
    // Its window has not passed: the launch opens then; a new window is refused for that reason now.
    await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, newer))).rejects.toThrow(/whose window has not passed/);
  });

  it("several pending: those that only burn land first, then the newest that can attest; funding counts the rent-exempt floor between landings", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    await attest(conn, ledger, WINDOW);
    const w1 = { notBefore: WINDOW.notAfter + 600n, notAfter: WINDOW.notAfter + 4_200n };
    const w2 = { notBefore: WINDOW.notAfter + 900n, notAfter: WINDOW.notAfter + 4_500n };
    await legacySignature(ledger, 11, w1);
    await new Promise((r) => setTimeout(r, 5)); // a later createdAt
    const h2 = await legacySignature(ledger, 12, w2);
    conn.setClock(WINDOW.notAfter + 1n);
    const lamports = await fundingLamportsForPending(conn.asConnection(), { launch: LAUNCH, identity, ledger });
    expect(lamports).toBe(2n * 5_000n + BigInt(await conn.getMinimumBalanceForRentExemption(0)));
    expect(await fundingLamportsForPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, count: 0 })).toBe(0n);
    const payer = Keypair.generate();
    fund(conn, payer.publicKey, lamports);
    const out = await landOrBurnPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, payer, allowLocalnet: true });
    expect(out.landings.map((l) => [l.leaf, l.outcome.status])).toEqual([
      [12, "attested"],
      [11, "burned"],
    ]);
    expect(toHex(conn.get(attestationAddress(LAUNCH))!.data.subarray(140, 172))).toBe(toHex(h2));
    expect((await ledger.get(identity.identityId, 11))?.retired).toBe(true);
    expect(out.remaining).toEqual([]);
  });

  it("a signature that can only burn now (its window opens more than 7 days out) lands before one that would attest", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    await attest(conn, ledger, WINDOW);
    conn.setClock(WINDOW.notAfter + 1n);
    const now = WINDOW.notAfter + 1n;
    await legacySignature(ledger, 40, { notBefore: now + 8n * DAY, notAfter: now + 8n * DAY + 3_600n }); // burns now; could attest in a day
    await new Promise((r) => setTimeout(r, 5));
    const h41 = await legacySignature(ledger, 41, { notBefore: now + 600n, notAfter: now + 4_200n });
    const pending = await findPendingAttestations(conn.asConnection(), { launch: LAUNCH, lmsPublicKey: identity.publicKey, ledger });
    expect(pending.map((p) => [p.leaf, p.landingNow]).sort()).toEqual([
      [40, "burns"],
      [41, "attests"],
    ]);
    const payer = Keypair.generate();
    fund(conn, payer.publicKey, await fundingLamportsForPending(conn.asConnection(), { launch: LAUNCH, identity, ledger }));
    const out = await landOrBurnPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, payer, allowLocalnet: true });
    expect(out.landings.map((l) => [l.leaf, l.outcome.status])).toEqual([
      [40, "burned"],
      [41, "attested"],
    ]);
    expect(toHex(conn.get(attestationAddress(LAUNCH))!.data.subarray(140, 172))).toBe(toHex(h41));
  });

  it("checks the cluster and its inputs before anything is read or sent", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const payer = Keypair.generate();
    await expect(landOrBurnPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, payer })).rejects.toThrow(/localnet/);
    await expect(landOrBurnPending(conn.asConnection(), { launch: LAUNCH, identity, ledger, payer: payer.publicKey as unknown as Keypair, allowLocalnet: true })).rejects.toThrow(TypeError);
    expect(conn.sent).toHaveLength(0);
  });
});

describe("getLaunchFlowStatus warns about older signatures", () => {
  it("window-missed always says an older signature can still take its place; without a ledger nothing is listed", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    await attest(conn, ledger, WINDOW);
    conn.setClock(WINDOW.notAfter + 1n);
    const s = await getLaunchFlowStatus(conn.asConnection(), LAUNCH);
    expect([s.step, s.pendingSignatures]).toEqual(["window-missed", null]);
    expect(s.summary).toMatch(/^Window passed: sign a new opening time/);
    expect(s.warnings).toEqual([
      "An earlier signature for this launch that was sent but never landed can still take its place if its own time window has not ended: land it first (landOrBurnPending) or wait until that window ends.",
    ]);
    const before = await getLaunchFlowStatus(world().asConnection(), LAUNCH, { pending: { ledger: createMemoryLeafLedger(), lmsPublicKey: identity.publicKey } });
    expect([before.step, before.pendingSignatures, before.warnings]).toEqual(["attest", [], []]);
  });
});

describe("the retired mark in the ledger", () => {
  it("is optional (0.4.0 records parse), boolean only, never on a landing that attested, and kept by export and import", async () => {
    const store = memoryLeafLedgerStore();
    const ledger = createLeafLedger(store);
    const msg = attestationMessage({ launch: LAUNCH, paramsHash: fromHex(v.attestation.paramsHash), creator: CREATOR, metadataHash: HASH, notBefore: 100n, notAfter: 3_700n });
    await reserveAndSign(ledger, identity.keyPair, 20, msg, { launch: LAUNCH });
    const exportedSigned = await exportLeafRecords(ledger, identity.identityId);
    await expect(ledger.markLanded(identity.identityId, 20, { attested: true, retired: true })).rejects.toBeInstanceOf(LeafLedgerError);
    await ledger.markLanded(identity.identityId, 20, { attested: false, retired: true });
    const rec = await ledger.get(identity.identityId, 20);
    expect([rec?.status, rec?.attested, rec?.retired]).toEqual(["landed", false, true]);
    // Another device imports the signature, never the landing or the retirement (audit 4, ID-F4: an export is not proof
    // of a landing): it reads them from the chain again (landOrBurnPending confirms a used leaf and retires it).
    const other = createMemoryLeafLedger();
    await importLeafRecords(other, identity.publicKey, exportedSigned);
    expect((await other.get(identity.identityId, 20))?.retired).toBeUndefined();
    const summary = await importLeafRecords(other, identity.publicKey, await exportLeafRecords(ledger, identity.identityId));
    expect(summary.unchanged).toBe(1);
    expect(await other.get(identity.identityId, 20)).toMatchObject({ status: "signed", attested: null });
    expect((await other.get(identity.identityId, 20))?.retired).toBeUndefined();
    // A record without the field (0.4.0) parses; a non-boolean one is refused.
    const k = (await store.keys("noised/pq/leaf-ledger/v1/leaf/")).find((x) => x.endsWith("/0020"))!;
    const raw = JSON.parse((await store.get(k))!) as Record<string, unknown>;
    delete raw["retired"];
    await store.put(k, JSON.stringify(raw));
    expect((await ledger.get(identity.identityId, 20))?.retired).toBeUndefined();
    await store.put(k, JSON.stringify({ ...raw, retired: "yes" }));
    await expect(ledger.get(identity.identityId, 20)).rejects.toBeInstanceOf(LeafLedgerError);
  });

  it("the cap still counts burns that were not retirements", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    const r = await signOnly(conn, ledger, WINDOW);
    conn.delete(RECORD); // the record is lost before it lands: a burn-only landing
    fund(conn, r.payer.publicKey, r.fundingLamports);
    expect((await sendAttestLaunchTx(conn.asConnection(), r, { ledger })).status).toBe("burned");
    conn.set(RECORD, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.tokenMeta.data) });
    const e = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { notBefore: WINDOW.notBefore + 1n, notAfter: WINDOW.notAfter }, { maxBurnOnlyLandings: 1 })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AttestRetryLimitError);
  });
});

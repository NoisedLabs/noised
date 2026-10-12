/**
 * `pq_authorize` from the SDK (`src/pq/authorize.ts`), byte for byte against
 * `vectors/programmable.json` (a copy of tests/integration/vectors/
 * programmable.json, written by programmable_vectors.rs and landed on the
 * launchpad build; independently checked by scripts/pq/lms_reference.py):
 *
 * - the payload hashes of the three kinds (activate, freeze, revoke), the
 *   140-byte messages, their leaf probe, the deterministic LMS signatures,
 *   the instruction data and accounts, the Authorization account bytes and
 *   the Authorized event, for kinds 1, 2 and 3;
 * - the v1 transaction size (constant, under 4,096 with a priority fee) and
 *   the payer funding from the cluster's rent;
 * - every refusal before signing (kind, cluster, launch, creator, identity),
 *   leaving the ledger untouched, and the leaf ledger's guarantees (same
 *   bytes on a rebuild, recorded before return, never a second message at a
 *   leaf, a set leaf never re-sent);
 * - sending through the model of the program (test/attest_world.ts):
 *   authorized, a second signature of the same authorization and another
 *   identity's signature only burn, ConstraintSeeds resent with the same
 *   signature, PqLeafUsed read from the accounts, a dropped send pending;
 * - `verifyAuthorization` and its mutations.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { AUTHORIZATION, PROGRAM_IDS } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { decodeAuthorization, decodeIdentity } from "../src/launch/accounts.js";
import { authorizationAddress, autopilotAddress, identityAddress } from "../src/pda.js";
import {
  AUTHORIZE_COMPUTE_UNITS,
  AUTHORIZE_LOADED_ACCOUNTS_BYTES,
  AuthorizePayerFundingError,
  authorizeFeeLamports,
  authorizeTransactionSize,
  authorizeTxConfig,
  buildPqAuthorizeTx,
  confirmAuthorization,
  fundingLamportsForAuthorize,
  pqAuthorizeInstruction,
  rewrapPqAuthorizeTx,
  sendPqAuthorizeTx,
  verifyAuthorization,
  type AuthorizeKind,
  type BuildPqAuthorizeArgs,
  type PqAuthorizeReady,
} from "../src/pq/authorize.js";
import { authorizationMessage, decodePqAttestEvent, deriveIdentity, leafProbeStart, type PqIdentity } from "../src/pq/identity.js";
import { acknowledgeUnknownLeaves, createMemoryLeafLedger, LeafConflictError, reserveAndSign, UnknownLeavesError, type LeafLedger } from "../src/pq/leafLedger.js";
import { lmsVerify } from "../src/pq/lms.js";
import { activationPayload, AUTH_DOMAINS, FREEZE_DEFAULT_VALID_SECS, freezePayload, revokePayload } from "../src/programmable/autopilot/logic.js";
import { GENESIS_HASHES } from "../src/rpc/cluster.js";
import { sendAndConfirm } from "../src/rpc/index.js";
import { compileV1Message, decodeV1Transaction, signV1Message } from "../src/tx/v1.js";
import { AttestConnection, bitmapOf, emulatedAuthMessage, emulateLaunchpad, identityAccountBytes, ProgramError } from "./attest_world.js";
import { readJson } from "./helpers.js";
import { accountBytes } from "./world.js";

interface AuthCase {
  name: string;
  kind: number;
  payloadHash: string;
  message: string;
  messageHash: string;
  signature: string;
  q: number;
  probeStart: number;
  accountData: string;
  address: string;
  bump: number;
  authorized: string;
  pqAuthorize: { accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
}
interface ProgVectors {
  authorizations: { autopilot: string; graphHash: string; operator: string; activeAuth: string; activateAt: number; freezeNotAfter: number; cases: AuthCase[] };
  launch: { address: string; creator: string; payer: string; publicKey: string; pqIdentity: string; launchSeed: string; landsAt: number; data: string };
  identity: { address: string; data: string };
}

const v = readJson<ProgVectors>("./vectors/programmable.json");
const lms = readJson<{ derivation: { master: string } }>("./vectors/lms.json");
const LAUNCH = new PublicKey(v.launch.address);
const CREATOR = new PublicKey(v.launch.creator);
const VECTOR_PAYER = new PublicKey(v.launch.payer);
const A = v.authorizations;
const AUTOPILOT = new PublicKey(A.autopilot);
const GRAPH_HASH = fromHex(A.graphHash);
const OPERATOR = new PublicKey(A.operator);
/** The freeze vector's not_after (payload v2, review 4, R5): an hour after the vector launch lands. */
const FREEZE_NOT_AFTER = BigInt(A.freezeNotAfter);
const CASES = A.cases;
/** The revocation vector's active_auth (payload v3, audit 4 A4-3): the authorization that activated the running graph. */
const ACTIVE_AUTH = new PublicKey(A.activeAuth);
const PAYER = Keypair.fromSeed(sha256(utf8("authorize.test/payer")));
/** Rent at the mocked default: (128 + size) x 6,960 lamports. */
const rent = (size: number): bigint => BigInt((128 + size) * 6_960);
const kindOf = (c: AuthCase): AuthorizeKind => c.kind as AuthorizeKind;

let identity: PqIdentity;
let other: PqIdentity;

beforeAll(async () => {
  identity = await deriveIdentity(fromHex(lms.derivation.master), "localnet", 0);
  other = await deriveIdentity(fromHex(lms.derivation.master), "localnet", 1);
});

/** The launch's autopilot running the vector graph (what a freeze approval is checked against). */
function autopilotBytes(o: { activeGraph?: Uint8Array; frozen?: boolean } = {}): Uint8Array {
  return accountBytes("autopilot", "Autopilot", {
    version: 1,
    bump: 255,
    treasuryBump: 254,
    launch: LAUNCH,
    mint: PublicKey.default,
    dammPool: PublicKey.default,
    activeGraph: o.activeGraph ?? GRAPH_HASH,
    pendingGraph: new Uint8Array(32),
    pendingActivateAt: 0n,
    pendingOperator: PublicKey.default,
    activatedAt: 0n,
    frozen: o.frozen ?? false,
    operator: OPERATOR,
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
  });
}

/** The vector launch (names identity 0) at its landing time, its autopilot running the vector graph, landing launchpad transactions through the model. */
function vectorWorld(): AttestConnection {
  const conn = new AttestConnection();
  conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.launch.data) });
  conn.set(AUTOPILOT, { owner: PROGRAM_IDS.autopilot, data: autopilotBytes() });
  conn.setClock(BigInt(v.launch.landsAt));
  conn.land = (wire) => emulateLaunchpad(conn, wire);
  return conn;
}

/** A ledger that assigned case `c`'s message to the vector's leaf (reserved, never signed): the identity signs it there. */
async function ledgerAt(c: AuthCase): Promise<LeafLedger> {
  const ledger = createMemoryLeafLedger();
  expect(await ledger.reserve(identity.identityId, c.q, fromHex(c.messageHash), { launch: LAUNCH })).toBe("reserved");
  return ledger;
}

/** Where case `c`'s message starts in the secret probe v2 (audit 4, ID-F1a): the SDK's leaf for it in an empty ledger. */
const startOf = (c: AuthCase): number => identity.keyPair.leafProbeStart(fromHex(c.message));

/** The vector inputs of case `c` (a freeze with the vector's not_after). */
function args(ledger: LeafLedger, c: AuthCase, over: Partial<BuildPqAuthorizeArgs> = {}): BuildPqAuthorizeArgs {
  return {
    launch: LAUNCH,
    creator: CREATOR,
    identity,
    ledger,
    kind: kindOf(c),
    payloadHash: fromHex(c.payloadHash),
    payer: PAYER,
    allowLocalnet: true,
    ...(c.kind === 2 ? { freezeNotAfter: FREEZE_NOT_AFTER } : {}),
    ...over,
  };
}

function fund(conn: AttestConnection, payer: PublicKey, lamports: bigint): void {
  conn.set(payer, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(lamports) });
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The vector launch's bytes with `from` replaced by `to` (once). */
function patchedLaunch(from: Uint8Array, to: Uint8Array): Uint8Array {
  const data = fromHex(v.launch.data);
  const at = indexOfBytes(data, from);
  if (at < 0) throw new Error("the vector launch does not hold these bytes");
  data.set(to, at);
  return data;
}

const i64At = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(at, true);
const u64At = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);

describe("pq_authorize bytes (the Rust vectors, kinds 1, 2 and 3)", () => {
  it("the vector identity is identity 0 of lms.json's master on localnet; the autopilot is the launch's", () => {
    expect(toHex(identity.publicKey)).toBe(v.launch.publicKey);
    expect(toHex(identity.identityId)).toBe(v.launch.pqIdentity);
    expect(identity.address.toBase58()).toBe(v.identity.address);
    expect(autopilotAddress(LAUNCH).equals(AUTOPILOT)).toBe(true);
    expect(CASES.map((c) => [c.kind, c.name])).toEqual([
      [1, "GRAPH_ACTIVATE"],
      [2, "GRAPH_FREEZE"],
      [3, "OPERATOR_REVOKE"],
    ]);
  });

  it("payload hashes: activate (graph, i64 time), freeze v2 (graph, i64 not_after), revoke v3 (graph, operator, active_auth)", () => {
    expect(toHex(activationPayload(AUTOPILOT, GRAPH_HASH, BigInt(A.activateAt)))).toBe(CASES[0]!.payloadHash);
    expect(toHex(freezePayload(AUTOPILOT, GRAPH_HASH, FREEZE_NOT_AFTER))).toBe(CASES[1]!.payloadHash);
    expect(toHex(revokePayload(AUTOPILOT, GRAPH_HASH, OPERATOR, ACTIVE_AUTH))).toBe(CASES[2]!.payloadHash);
    // Audit 4, A4-3: the revocation names the activation it revokes the operator of.
    expect(AUTH_DOMAINS.REVOKE).toBe("PHX-OP-REVOKE-V3");
    const framed = Uint8Array.from([...utf8("PHX-OP-REVOKE-V3"), ...AUTOPILOT.toBytes(), ...GRAPH_HASH, ...OPERATOR.toBytes(), ...ACTIVE_AUTH.toBytes()]);
    expect(toHex(sha256(framed))).toBe(CASES[2]!.payloadHash);
    expect(toHex(revokePayload(AUTOPILOT, GRAPH_HASH, OPERATOR, PublicKey.default))).not.toBe(CASES[2]!.payloadHash);
    expect(() => revokePayload(AUTOPILOT, GRAPH_HASH, OPERATOR, undefined as never)).toThrow(/activeAuth/);
  });

  it("freeze payload v2: the domain, the layout (16 + 32 + 32 + 8 bytes), and every input matters", () => {
    expect(AUTH_DOMAINS.FREEZE).toBe("PHX-GRAPH-FRZ-V2");
    expect(FREEZE_NOT_AFTER).toBe(BigInt(v.launch.landsAt) + FREEZE_DEFAULT_VALID_SECS);
    const le = new Uint8Array(8);
    new DataView(le.buffer).setBigInt64(0, FREEZE_NOT_AFTER, true);
    const framed = Uint8Array.from([...utf8("PHX-GRAPH-FRZ-V2"), ...AUTOPILOT.toBytes(), ...GRAPH_HASH, ...le]);
    expect(framed).toHaveLength(88);
    expect(toHex(sha256(framed))).toBe(CASES[1]!.payloadHash);
    expect(toHex(freezePayload(AUTOPILOT, GRAPH_HASH, FREEZE_NOT_AFTER + 1n))).not.toBe(CASES[1]!.payloadHash);
    expect(toHex(freezePayload(AUTOPILOT, new Uint8Array(32), FREEZE_NOT_AFTER))).not.toBe(CASES[1]!.payloadHash);
    expect(toHex(freezePayload(OPERATOR, GRAPH_HASH, FREEZE_NOT_AFTER))).not.toBe(CASES[1]!.payloadHash);
    // Never the payload of another kind, and never v1's (SHA256("PHX-GRAPH-FRZ-V1" || autopilot || graph)).
    expect(toHex(freezePayload(AUTOPILOT, GRAPH_HASH, FREEZE_NOT_AFTER))).not.toBe(toHex(activationPayload(AUTOPILOT, GRAPH_HASH, FREEZE_NOT_AFTER)));
    expect(CASES[1]!.payloadHash).not.toBe(toHex(sha256(Uint8Array.from([...utf8("PHX-GRAPH-FRZ-V1"), ...AUTOPILOT.toBytes(), ...GRAPH_HASH]))));
    // notAfter: bigint unix seconds in the i64 range.
    expect(() => freezePayload(AUTOPILOT, GRAPH_HASH, Number(FREEZE_NOT_AFTER) as unknown as bigint)).toThrow(TypeError);
    expect(() => freezePayload(AUTOPILOT, GRAPH_HASH, 1n << 63n)).toThrow(RangeError);
    expect(() => freezePayload(AUTOPILOT, GRAPH_HASH, -(1n << 63n) - 1n)).toThrow(RangeError);
    expect(freezePayload(AUTOPILOT, GRAPH_HASH, (1n << 63n) - 1n)).toHaveLength(32);
  });

  for (const c of CASES) {
    it(`${c.name}: message, probe, deterministic signature, instruction, account and event`, () => {
      const payloadHash = fromHex(c.payloadHash);
      const message = authorizationMessage({ launch: LAUNCH, creator: CREATOR, kind: c.kind, payloadHash });
      expect(toHex(message)).toBe(c.message);
      expect(message).toHaveLength(AUTHORIZATION.MESSAGE_LEN);
      expect(toHex(emulatedAuthMessage(LAUNCH, CREATOR, c.kind, payloadHash))).toBe(c.message);
      expect(toHex(sha256(message))).toBe(c.messageHash);
      expect(leafProbeStart(identity.publicKey.subarray(8, 24), message)).toBe(c.probeStart);
      const sig = fromHex(c.signature);
      expect(lmsVerify(identity.publicKey, message, sig)).toBe(c.q);

      const ix = pqAuthorizeInstruction({ payer: VECTOR_PAYER, launch: LAUNCH, lmsPublicKey: identity.publicKey, lmsSignature: sig, kind: kindOf(c), payloadHash });
      expect(toHex(ix.data)).toBe(c.pqAuthorize.data);
      expect(toHex(ix.data.subarray(0, 8))).toBe("89bf3ed6b9288ff7");
      expect(ix.data).toHaveLength(2_609);
      expect(ix.programId.equals(PROGRAM_IDS.launchpad)).toBe(true);
      expect(ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toEqual(c.pqAuthorize.accounts);
      // The IDL's order and flags: payer (w, s), launch, identity (w), authorization (w), system program.
      const idl = idlCodecs().launchpad.instruction("pq_authorize");
      expect(idl.accounts.map((a) => [a.name, a.writable === true, a.signer === true])).toEqual([
        ["payer", true, true],
        ["launch", false, false],
        ["identity", true, false],
        ["authorization", true, false],
        ["system_program", false, false],
      ]);
      expect(ix.keys[3]!.pubkey.equals(authorizationAddress(LAUNCH, c.kind, payloadHash))).toBe(true);
      expect(ix.keys[2]!.pubkey.equals(identityAddress(identity.publicKey))).toBe(true);

      const auth = decodeAuthorization(new PublicKey(c.address), fromHex(c.accountData));
      expect(auth.authorized).toBe(true);
      expect([auth.version, auth.bump, auth.kind, auth.leaf]).toEqual([1, c.bump, c.kind, c.q]);
      expect(auth.launch.equals(LAUNCH)).toBe(true);
      expect(toHex(auth.pqIdentity)).toBe(v.launch.pqIdentity);
      expect(toHex(auth.payloadHash)).toBe(c.payloadHash);
      expect(toHex(auth.messageHash)).toBe(c.messageHash);
      expect(toHex(auth.signature)).toBe(c.signature);
      expect(fromHex(c.accountData)).toHaveLength(AUTHORIZATION.ACCOUNT_LEN);
      const data = fromHex(c.accountData);
      expect(auth.unixTime).toBe(i64At(data, AUTHORIZATION.OFFSETS.UNIX_TIME));
      expect(auth.slot).toBe(u64At(data, AUTHORIZATION.OFFSETS.SLOT));

      const disc = idlCodecs().launchpad.idl.events!.find((e) => e.name === "Authorized")!.discriminator;
      const ev = decodePqAttestEvent(Uint8Array.from([...disc, ...fromHex(c.authorized)]));
      expect(ev?.name).toBe("Authorized");
      if (ev?.name !== "Authorized") throw new Error("unreachable");
      expect([ev.kind, ev.leaf, ev.unixTime, ev.slot]).toEqual([c.kind, c.q, auth.unixTime, auth.slot]);
      expect(ev.authorization.toBase58()).toBe(c.address);
      expect(toHex(ev.payloadHash)).toBe(c.payloadHash);
    });
  }

  it("refuses a kind other than 1, 2 or 3, and inputs of the wrong length", () => {
    const base = { payer: PAYER.publicKey, launch: LAUNCH, lmsPublicKey: identity.publicKey, lmsSignature: fromHex(CASES[0]!.signature), kind: 1 as AuthorizeKind, payloadHash: fromHex(CASES[0]!.payloadHash) };
    for (const kind of [0, 4, 255, 1.5]) expect(() => pqAuthorizeInstruction({ ...base, kind: kind as AuthorizeKind })).toThrow(/kind/);
    expect(() => pqAuthorizeInstruction({ ...base, lmsPublicKey: new Uint8Array(55) })).toThrow(/56 bytes/);
    expect(() => pqAuthorizeInstruction({ ...base, lmsSignature: new Uint8Array(2_507) })).toThrow(/2508 bytes/);
    expect(() => pqAuthorizeInstruction({ ...base, payloadHash: new Uint8Array(31) })).toThrow(/32 bytes/);
  });

  it("transaction size: constant whatever the kind and payload, under 4,096 with a priority fee", () => {
    const size = authorizeTransactionSize();
    const withFee = authorizeTransactionSize({ priorityFee: true });
    expect(withFee).toBe(size + 8);
    expect(withFee).toBeLessThanOrEqual(4_096);
    expect(size).toBe(2_924);
    // The largest inputs: a real signature, payer and accounts, a priority fee.
    for (const c of CASES) {
      const ix = pqAuthorizeInstruction({ payer: PAYER.publicKey, launch: LAUNCH, lmsPublicKey: identity.publicKey, lmsSignature: fromHex(c.signature), kind: kindOf(c), payloadHash: fromHex(c.payloadHash) });
      const msg = compileV1Message(PAYER.publicKey, [ix], "11111111111111111111111111111111", { computeUnitLimit: AUTHORIZE_COMPUTE_UNITS, loadedAccountsDataSizeLimit: AUTHORIZE_LOADED_ACCOUNTS_BYTES, priorityFeeLamports: 300_000n });
      expect(signV1Message(msg, [PAYER]).length).toBe(withFee);
    }
  });

  it("config words: 300,000 CU and 2 MiB by default; a compute-unit price becomes the v1 priority fee", () => {
    expect(authorizeTxConfig()).toEqual({ computeUnitLimit: 300_000, loadedAccountsDataSizeLimit: 2 * 1024 * 1024, priorityFeeLamports: null });
    expect(authorizeTxConfig({ computeUnitPrice: 1_000_000n }).priorityFeeLamports).toBe(300_000n);
    expect(authorizeFeeLamports({ computeUnitPrice: 1_000_000n })).toBe(305_000n);
    expect(() => authorizeTxConfig({ computeUnitLimit: 0 })).toThrow(/computeUnitLimit/);
    expect(() => authorizeTxConfig({ loadedAccountsDataSizeLimit: 0 })).toThrow(/loadedAccountsDataSizeLimit/);
  });
});

describe("payer funding (rent from the cluster)", () => {
  it("rent(196) + rent(2,669) + 5,000, or only the accounts that do not exist yet", async () => {
    const conn = vectorWorld();
    const c = conn.asConnection();
    expect(await fundingLamportsForAuthorize(c)).toBe(rent(196) + rent(2_669) + 5_000n);
    expect(await fundingLamportsForAuthorize(c)).toBe(21_727_160n);
    const o = { launch: LAUNCH, lmsPublicKey: identity.publicKey, kind: 1 as AuthorizeKind, payloadHash: fromHex(CASES[0]!.payloadHash) };
    expect(await fundingLamportsForAuthorize(c, o)).toBe(21_727_160n);
    conn.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(identity.publicKey, bitmapOf([1])) });
    expect(await fundingLamportsForAuthorize(c, o)).toBe(rent(2_669) + 5_000n);
    conn.set(new PublicKey(CASES[0]!.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(CASES[0]!.accountData) });
    expect(await fundingLamportsForAuthorize(c, { ...o, computeUnitPrice: 1_000_000n })).toBe(305_000n);
    await expect(fundingLamportsForAuthorize(c, { launch: LAUNCH })).rejects.toThrow(/together/);
  });
});

describe("buildPqAuthorizeTx", () => {
  for (const c of CASES) {
    it(`${c.name}: at the vector's leaf (the ledger assigned it there), the vector's signature, recorded before it is returned`, async () => {
      const conn = vectorWorld();
      const ledger = await ledgerAt(c);
      const built = await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c));
      expect(built.status).toBe("ready");
      const r = built as PqAuthorizeReady;
      expect(r.leaf).toBe(c.q);
      expect(toHex(r.message)).toBe(c.message);
      expect(toHex(r.messageHash)).toBe(c.messageHash);
      expect(toHex(r.lmsSignature)).toBe(c.signature);
      expect(r.authorization.toBase58()).toBe(c.address);
      expect(r.authorizationAddress.toBase58()).toBe(c.address);
      expect(r.retry).toBe(false);
      expect(r.warnings).toEqual([]);
      expect(r.sizeBytes).toBe(authorizeTransactionSize());
      expect(r.fundingLamports).toBe(21_727_160n);
      // The transaction carries exactly the vector instruction (with this payer).
      const d = decodeV1Transaction(r.tx);
      expect(d.accountKeys[0]!.equals(PAYER.publicKey)).toBe(true);
      expect(toHex(d.instructions[0]!.data)).toBe(c.pqAuthorize.data);
      expect([d.computeUnitLimit, d.loadedAccountsDataSizeLimit, d.priorityFeeLamports]).toEqual([300_000, 2 * 1024 * 1024, null]);
      const rec = await ledger.get(identity.identityId, c.q);
      expect(rec?.status).toBe("signed");
      expect(rec?.signature).toBe(c.signature);
      expect(rec?.launch).toBe(LAUNCH.toBase58());
      expect(rec?.messageHash).toBe(c.messageHash);
    });
  }

  it("a rebuild (expired blockhash) gives the same leaf and the same signature, never a second one", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const c = CASES[0]!;
    const first = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    conn.blockhash = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
    const again = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    expect(again.retry).toBe(true);
    expect(again.leaf).toBe(first.leaf);
    expect(toHex(again.lmsSignature)).toBe(toHex(first.lmsSignature));
    expect(again.blockhash).not.toBe(first.blockhash);
    expect((await ledger.list(identity.identityId)).length).toBe(1);
    // Same payer and blockhash: the same transaction bytes.
    conn.blockhash = first.blockhash;
    const third = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    expect(toHex(third.tx)).toBe(toHex(first.tx));
  });

  it("never a second message at a leaf: a leaf reserved for another message moves this one to the next free leaf", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const c = CASES[0]!;
    const s = startOf(c);
    expect(await ledger.reserve(identity.identityId, s, sha256(utf8("another message")))).toBe("reserved");
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    // The next leaf after the probe start that neither the ledger nor this process (earlier tests) gave to another message.
    expect(built.leaf).not.toBe(s);
    expect((built.leaf - s + 1024) % 1024).toBeLessThan(16);
    expect(lmsVerify(identity.publicKey, built.message, built.lmsSignature)).toBe(built.leaf);
    expect((await ledger.get(identity.identityId, s))?.signature).toBeNull();
    // And this process refuses to sign anything else at a leaf that signed this message.
    await expect(reserveAndSign(createMemoryLeafLedger(), identity.keyPair, built.leaf, utf8("anything else"))).rejects.toThrow(LeafConflictError);
  });

  it("audit 4, ID-F1: leaves used on-chain that the ledger never signed at refuse before anything is reserved; once acknowledged, the identity signs", async () => {
    const conn = vectorWorld();
    const c = CASES[1]!;
    const used = [700, 3].filter((q) => q !== startOf(c));
    conn.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(identity.publicKey, bitmapOf(used)) });
    const ledger = createMemoryLeafLedger();
    const e = await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnknownLeavesError);
    expect(e).toMatchObject({ unknownCount: used.length, chosenLeafSetOnChain: false });
    expect(await ledger.list(identity.identityId)).toEqual([]);
    await acknowledgeUnknownLeaves(ledger, identity.publicKey, bitmapOf(used), { expectedCount: used.length });
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    expect(built.leaf).toBe(startOf(c));
    expect(built.fundingLamports).toBe(rent(2_669) + 5_000n);
  });

  it("a message whose leaf is already set on-chain is not re-sent (leaf-landed)", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const c = CASES[2]!;
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    conn.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(identity.publicKey, bitmapOf([built.leaf])) });
    const again = await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c));
    expect(again.status).toBe("leaf-landed");
    if (again.status !== "leaf-landed") throw new Error("unreachable");
    expect(again.leaf).toBe(built.leaf);
    expect(again.authorization.toBase58()).toBe(c.address);
  });

  it("warns about an earlier approval of this launch that was signed but never seen landing", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const first = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, CASES[1]!))) as PqAuthorizeReady;
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, CASES[2]!))) as PqAuthorizeReady;
    expect(built.warnings).toEqual([expect.stringMatching(new RegExp(`earlier approval of kind 2 for this launch \\(leaf ${first.leaf}\\) was signed but never seen landing`))]);
  });

  describe("refuses before signing (the ledger stays empty)", () => {
    const refused = async (conn: AttestConnection, over: Partial<BuildPqAuthorizeArgs>, re: RegExp): Promise<void> => {
      const ledger = createMemoryLeafLedger();
      await expect(buildPqAuthorizeTx(conn.asConnection(), args(ledger, CASES[0]!, over))).rejects.toThrow(re);
      expect(await ledger.list(identity.identityId)).toEqual([]);
      expect(await ledger.list(other.identityId)).toEqual([]);
    };

    it("a kind the autopilot does not read (0, 4, 255): before any RPC", async () => {
      for (const kind of [0, 4, 255]) {
        const conn = vectorWorld();
        await refused(conn, { kind: kind as AuthorizeKind }, /kind/);
        expect(conn.calls).toEqual([]);
      }
    });

    it("an endpoint of another cluster (genesis hash), or localnet without the opt-in: before any reservation", async () => {
      const conn = vectorWorld();
      conn.genesisHash = GENESIS_HASHES.mainnet;
      await refused(conn, {}, /refusing to sign: keys for localnet, but the endpoint serves mainnet/);
      await refused(vectorWorld(), { allowLocalnet: false }, /allowLocalnet/);
    });

    it("a launch that does not exist or is not finalized", async () => {
      const conn = vectorWorld();
      conn.hiddenAtFinalized.add(LAUNCH.toBase58());
      await refused(conn, {}, /not finalized/);
      expect((await buildPqAuthorizeTx(conn.asConnection(), args(createMemoryLeafLedger(), CASES[0]!, { launchCommitment: "confirmed" }))).status).toBe("ready");
      await refused(vectorWorld().delete(LAUNCH), {}, /does not exist/);
    });

    it("a launch created by another wallet, not at its own PDA, or naming another identity", async () => {
      await refused(vectorWorld(), { creator: PAYER.publicKey }, /created by .*not by this wallet/);
      const seedMoved = vectorWorld().set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: patchedLaunch(fromHex(v.launch.launchSeed), sha256(utf8("another seed"))) });
      await refused(seedMoved, {}, /not at the PDA/);
      await refused(vectorWorld(), { identity: other }, /names another post-quantum identity/);
    });

    it("an authorization already written: nothing to sign (already-authorized), and the ledger is not touched", async () => {
      const conn = vectorWorld();
      const c = CASES[0]!;
      conn.set(new PublicKey(c.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(c.accountData) });
      const ledger = createMemoryLeafLedger();
      const r = await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c));
      expect(r.status).toBe("already-authorized");
      if (r.status !== "already-authorized") throw new Error("unreachable");
      expect(r.leaf).toBe(c.q);
      expect(r.authorization.publicKey.toBase58()).toBe(c.address);
      expect(await ledger.list(identity.identityId)).toEqual([]);
    });
  });
});

describe("a freeze (kind 2) is signed and landed only to be used until its freezeNotAfter (review 4, R5)", () => {
  const F = CASES[1]!;
  const refusedFreeze = async (conn: AttestConnection, over: Partial<BuildPqAuthorizeArgs>, re: RegExp | (new (...a: never[]) => Error)): Promise<void> => {
    const ledger = createMemoryLeafLedger();
    await expect(buildPqAuthorizeTx(conn.asConnection(), args(ledger, F, over))).rejects.toThrow(re);
    expect(await ledger.list(identity.identityId)).toEqual([]);
    expect(conn.sent).toEqual([]);
  };

  it("the built transaction carries the freezeNotAfter it signed (null for kinds 1 and 3)", async () => {
    const built = (await buildPqAuthorizeTx(vectorWorld().asConnection(), args(createMemoryLeafLedger(), F))) as PqAuthorizeReady;
    expect([built.kind, built.freezeNotAfter, toHex(built.payloadHash)]).toEqual([2, FREEZE_NOT_AFTER, F.payloadHash]);
    expect(((await buildPqAuthorizeTx(vectorWorld().asConnection(), args(createMemoryLeafLedger(), CASES[0]!))) as PqAuthorizeReady).freezeNotAfter).toBeNull();
  });

  it("no freezeNotAfter (or not bigint i64 seconds): refused before any RPC; freezeNotAfter on another kind is refused", async () => {
    for (const [over, re] of [
      [{ freezeNotAfter: undefined }, /a freeze \(kind 2\) needs freezeNotAfter/],
      [{ freezeNotAfter: Number(FREEZE_NOT_AFTER) as unknown as bigint }, TypeError],
      [{ freezeNotAfter: 1n << 63n }, RangeError],
      [{ freezeLandingMarginSecs: -1n }, /freezeLandingMarginSecs/],
    ] as const) {
      const conn = vectorWorld();
      await refusedFreeze(conn, over, re);
      expect(conn.calls).toEqual([]);
    }
    const conn = vectorWorld();
    await expect(buildPqAuthorizeTx(conn.asConnection(), args(createMemoryLeafLedger(), CASES[0]!, { freezeNotAfter: FREEZE_NOT_AFTER }))).rejects.toThrow(/for a freeze \(kind 2\), not kind 1/);
    await expect(buildPqAuthorizeTx(conn.asConnection(), args(createMemoryLeafLedger(), CASES[2]!, { freezeLandingMarginSecs: 0n }))).rejects.toThrow(/not kind 3/);
    expect(conn.calls).toEqual([]);
  });

  it("refuses to sign once the cluster clock plus the landing margin (default 60 s) is past it, before reserving a leaf", async () => {
    // 59 s left: under the default margin.
    await refusedFreeze(vectorWorld().setClock(FREEZE_NOT_AFTER - 59n), {}, /refusing to sign: this freeze approval would expire at 2026-01-01T01:00:00Z \(unix 1767229200\).*could never be used/);
    // 60 s left: signed.
    expect((await buildPqAuthorizeTx(vectorWorld().setClock(FREEZE_NOT_AFTER - 60n).asConnection(), args(createMemoryLeafLedger(), F))).status).toBe("ready");
    // No margin: allowed up to and including not_after, refused one second later.
    expect((await buildPqAuthorizeTx(vectorWorld().setClock(FREEZE_NOT_AFTER).asConnection(), args(createMemoryLeafLedger(), F, { freezeLandingMarginSecs: 0n }))).status).toBe("ready");
    await refusedFreeze(vectorWorld().setClock(FREEZE_NOT_AFTER + 1n), { freezeLandingMarginSecs: 0n }, /would expire at/);
    // A larger margin.
    await refusedFreeze(vectorWorld().setClock(FREEZE_NOT_AFTER - 600n), { freezeLandingMarginSecs: 601n }, /601 s are kept to land it/);
  });

  it("refuses a payload that is not the running graph's freeze until freezeNotAfter, and a launch with nothing to freeze", async () => {
    // The same payload with another not_after, or another running graph: the payload is not that freeze.
    await refusedFreeze(vectorWorld(), { freezeNotAfter: FREEZE_NOT_AFTER + 1n }, /payloadHash is not freezePayload\(autopilot, active graph, freezeNotAfter\)/);
    const moved = vectorWorld().set(AUTOPILOT, { owner: PROGRAM_IDS.autopilot, data: autopilotBytes({ activeGraph: new Uint8Array(32).fill(7) }) });
    await refusedFreeze(moved, {}, /payloadHash is not freezePayload/);
    await refusedFreeze(vectorWorld().delete(AUTOPILOT), {}, /no autopilot, so there is nothing to freeze/);
    await refusedFreeze(vectorWorld().set(AUTOPILOT, { owner: PROGRAM_IDS.autopilot, data: autopilotBytes({ frozen: true }) }), {}, /already frozen forever/);
    await refusedFreeze(vectorWorld().set(AUTOPILOT, { owner: PROGRAM_IDS.autopilot, data: autopilotBytes({ activeGraph: new Uint8Array(32) }) }), {}, /no graph is active/);
  });

  it("sendPqAuthorizeTx: not landed past its freezeNotAfter (nothing sent, the leaf intact); a different freezeNotAfter is refused; landed at not_after", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, F))) as PqAuthorizeReady;
    fund(conn, PAYER.publicKey, built.fundingLamports);
    conn.setClock(FREEZE_NOT_AFTER + 1n);
    await expect(sendPqAuthorizeTx(conn.asConnection(), built, { ledger })).rejects.toThrow(
      /refusing to send: this freeze approval expired at 2026-01-01T01:00:00Z \(unix 1767229200\) \(cluster time 1767229201\): landing it would only burn its leaf/,
    );
    // A margin to use it after it lands.
    conn.setClock(FREEZE_NOT_AFTER - 10n);
    await expect(sendPqAuthorizeTx(conn.asConnection(), built, { ledger, freezeLandingMarginSecs: 11n })).rejects.toThrow(/expired at/);
    await expect(sendPqAuthorizeTx(conn.asConnection(), built, { ledger, freezeNotAfter: FREEZE_NOT_AFTER + 1n })).rejects.toThrow(/not the time this freeze approval signed/);
    // An approval built before freezeNotAfter was recorded on it: the caller's value is used.
    const legacy = { ...built, freezeNotAfter: undefined } as unknown as PqAuthorizeReady;
    conn.setClock(FREEZE_NOT_AFTER + 1n);
    await expect(sendPqAuthorizeTx(conn.asConnection(), legacy, { ledger, freezeNotAfter: FREEZE_NOT_AFTER })).rejects.toThrow(/expired at/);
    expect(conn.sent).toEqual([]);
    expect((await ledger.get(identity.identityId, built.leaf))?.status).toBe("signed");
    // Up to and including not_after.
    conn.setClock(FREEZE_NOT_AFTER);
    expect((await sendPqAuthorizeTx(conn.asConnection(), built, { ledger })).status).toBe("authorized");
    // The freeze options are for a freeze only.
    const b1 = (await buildPqAuthorizeTx(vectorWorld().asConnection(), args(createMemoryLeafLedger(), CASES[0]!))) as PqAuthorizeReady;
    await expect(sendPqAuthorizeTx(conn.asConnection(), b1, { freezeNotAfter: FREEZE_NOT_AFTER })).rejects.toThrow(/for a freeze \(kind 2\), not kind 1/);
  });
});

describe("sendPqAuthorizeTx / confirmAuthorization (through the model of the program)", () => {
  it("authorized: the account is the vector's bytes, the ledger records the landing, a rebuild reports already-authorized", async () => {
    const conn = vectorWorld();
    const c = CASES[0]!;
    const data = fromHex(c.accountData);
    conn.setClock(i64At(data, AUTHORIZATION.OFFSETS.UNIX_TIME));
    conn.slot = Number(u64At(data, AUTHORIZATION.OFFSETS.SLOT));
    const ledger = await ledgerAt(c);
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    fund(conn, PAYER.publicKey, built.fundingLamports);
    const outcome = await sendPqAuthorizeTx(conn.asConnection(), built, { ledger });
    expect(outcome.status).toBe("authorized");
    if (outcome.status !== "authorized") throw new Error("unreachable");
    expect([outcome.leaf, outcome.ledgerUpdated]).toEqual([c.q, true]);
    expect(toHex(conn.get(new PublicKey(c.address))!.data)).toBe(c.accountData);
    expect(conn.get(PAYER.publicKey)!.lamports).toBe(0);
    const rec = await ledger.get(identity.identityId, c.q);
    expect([rec?.status, rec?.attested]).toEqual(["landed", true]);
    // Re-verified from the account state alone.
    const idAcc = decodeIdentity(identityAddress(identity.publicKey), conn.get(identityAddress(identity.publicKey))!.data);
    const check = verifyAuthorization(outcome.authorization, { launch: { publicKey: LAUNCH, creator: CREATOR, pqIdentity: identity.identityId }, identity: idAcc, expectedKind: 1, expectedPayloadHash: fromHex(c.payloadHash) });
    expect(check).toMatchObject({ ok: true, problems: [], leaf: c.q });
    expect(toHex(check.message)).toBe(c.message);
    const again = await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c));
    expect(again.status).toBe("already-authorized");
    expect(await confirmAuthorization(conn.asConnection(), LAUNCH, 1, fromHex(c.payloadHash))).toMatchObject({ status: "authorized", leaf: c.q });
  });

  it("a second signature of the same authorization (another device, another leaf) only burns its leaf", async () => {
    const conn = vectorWorld();
    const c = CASES[1]!;
    const ledger1 = await ledgerAt(c);
    const ledger2 = createMemoryLeafLedger();
    // Device 2 holds the vector leaf for something else: it signs the same message at its secret probe's leaf.
    expect(await ledger2.reserve(identity.identityId, c.q, sha256(utf8("device 2's other message")))).toBe("reserved");
    const payer2 = Keypair.fromSeed(sha256(utf8("authorize.test/payer2")));
    const b1 = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger1, c))) as PqAuthorizeReady;
    const b2 = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger2, c, { payer: payer2 }))) as PqAuthorizeReady;
    const leaf2 = startOf(c) === c.q ? (c.q + 1) % 1024 : startOf(c);
    expect([b1.leaf, b2.leaf]).toEqual([c.q, leaf2]);
    fund(conn, PAYER.publicKey, b1.fundingLamports);
    expect((await sendPqAuthorizeTx(conn.asConnection(), b1, { ledger: ledger1 })).status).toBe("authorized");
    fund(conn, payer2.publicKey, 5_000n);
    const o2 = await sendPqAuthorizeTx(conn.asConnection(), b2, { ledger: ledger2 });
    expect(o2).toMatchObject({ status: "burned", leaf: leaf2, reasons: ["already-authorized"], ledgerUpdated: true });
    const rec = await ledger2.get(identity.identityId, leaf2);
    expect([rec?.status, rec?.attested]).toEqual(["landed", false]);
    // The authorization still holds the first leaf.
    const auth = decodeAuthorization(new PublicKey(c.address), conn.get(new PublicKey(c.address))!.data);
    expect(auth.leaf).toBe(c.q);
  });

  it("another identity's signature lands as a burn only (wrong-identity); the launch's identity still authorizes afterwards", async () => {
    const conn = vectorWorld();
    const c = CASES[2]!;
    const payloadHash = fromHex(c.payloadHash);
    // Built by hand: the SDK refuses to sign for a launch that names another identity.
    const ledgerX = createMemoryLeafLedger();
    const message = authorizationMessage({ launch: LAUNCH, creator: CREATOR, kind: 3, payloadHash });
    const sig = await reserveAndSign(ledgerX, other.keyPair, 9, message, { launch: LAUNCH });
    const payerX = Keypair.fromSeed(sha256(utf8("authorize.test/payerX")));
    const ix = pqAuthorizeInstruction({ payer: payerX.publicKey, launch: LAUNCH, lmsPublicKey: other.publicKey, lmsSignature: sig, kind: 3, payloadHash });
    const tx = signV1Message(compileV1Message(payerX.publicKey, [ix], conn.blockhash, { computeUnitLimit: AUTHORIZE_COMPUTE_UNITS, loadedAccountsDataSizeLimit: AUTHORIZE_LOADED_ACCOUNTS_BYTES }), [payerX]);
    fund(conn, payerX.publicKey, rent(196) + rent(2_669) + 5_000n);
    await sendAndConfirm(conn.asConnection(), tx);
    const burned = await confirmAuthorization(conn.asConnection(), LAUNCH, 3, payloadHash, { leaf: 9, lmsPublicKey: other.publicKey, ledger: ledgerX });
    expect(burned).toMatchObject({ status: "burned", leaf: 9, reasons: ["wrong-identity"], ledgerUpdated: true });
    if (burned.status !== "burned") throw new Error("unreachable");
    expect(burned.authorization?.authorized).toBe(false);
    // The empty account left behind does not stop the launch's identity.
    const ledger = createMemoryLeafLedger();
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    expect(built.fundingLamports).toBe(rent(196) + 5_000n);
    fund(conn, PAYER.publicKey, built.fundingLamports);
    expect((await sendPqAuthorizeTx(conn.asConnection(), built, { ledger })).status).toBe("authorized");
  });

  it("ConstraintSeeds: the same signature is sent again with the accounts it names, never re-signed", async () => {
    const conn = vectorWorld();
    const c = CASES[0]!;
    let first = true;
    conn.land = (wire) => {
      if (first) {
        first = false;
        throw new ProgramError(2006, "ConstraintSeeds");
      }
      emulateLaunchpad(conn, wire);
    };
    const ledger = createMemoryLeafLedger();
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    fund(conn, PAYER.publicKey, built.fundingLamports);
    expect((await sendPqAuthorizeTx(conn.asConnection(), built, { ledger })).status).toBe("authorized");
    expect(conn.sent).toHaveLength(2);
    const sigs = conn.sent.map((w) => toHex(decodeV1Transaction(w).instructions[0]!.data));
    expect(sigs[0]).toBe(sigs[1]);
    const rewrapped = await rewrapPqAuthorizeTx(conn.asConnection(), built);
    expect(toHex(rewrapped.lmsSignature)).toBe(toHex(built.lmsSignature));
  });

  it("PqLeafUsed: a copy already landed, the outcome is read from the accounts", async () => {
    const conn = vectorWorld();
    const c = CASES[1]!;
    const ledger = await ledgerAt(c);
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    fund(conn, PAYER.publicKey, built.fundingLamports);
    await conn.sendRawTransaction(built.tx); // a relayer landed it first
    fund(conn, PAYER.publicKey, 5_000n);
    const outcome = await sendPqAuthorizeTx(conn.asConnection(), built, { ledger });
    expect(outcome).toMatchObject({ status: "authorized", leaf: c.q, ledgerUpdated: true });
  });

  it("refuses an underfunded payer or a remainder below the rent-exempt minimum; a dropped send is pending (same bytes next time)", async () => {
    const conn = vectorWorld();
    const c = CASES[2]!;
    const ledger = createMemoryLeafLedger();
    const built = (await buildPqAuthorizeTx(conn.asConnection(), args(ledger, c))) as PqAuthorizeReady;
    fund(conn, PAYER.publicKey, built.fundingLamports - 1n);
    await expect(sendPqAuthorizeTx(conn.asConnection(), built, { ledger })).rejects.toThrow(AuthorizePayerFundingError);
    fund(conn, PAYER.publicKey, built.fundingLamports + 10n);
    await expect(sendPqAuthorizeTx(conn.asConnection(), built, { ledger })).rejects.toThrow(/rent-exempt minimum/);
    expect(conn.sent).toHaveLength(0);
    fund(conn, PAYER.publicKey, built.fundingLamports);
    conn.dropSends = true;
    await expect(sendPqAuthorizeTx(conn.asConnection(), built, { ledger })).rejects.toThrow(/did not land.*same signature bytes/);
    expect(await confirmAuthorization(conn.asConnection(), LAUNCH, 3, fromHex(c.payloadHash), { leaf: built.leaf, lmsPublicKey: identity.publicKey })).toMatchObject({ status: "pending" });
    expect((await ledger.get(identity.identityId, built.leaf))?.status).toBe("signed");
  });
});

describe("verifyAuthorization (account state only)", () => {
  const c = CASES[0]!;
  const ctx = () => ({ launch: { publicKey: LAUNCH, creator: CREATOR, pqIdentity: identity.identityId }, identity: { lmsPublicKey: identity.publicKey, used: bitmapOf([c.q]) } });
  const vectorAuth = () => decodeAuthorization(new PublicKey(c.address), fromHex(c.accountData));

  it("the vector authorization verifies", () => {
    expect(verifyAuthorization(vectorAuth(), { ...ctx(), expectedKind: 1, expectedPayloadHash: fromHex(c.payloadHash) })).toMatchObject({ ok: true, problems: [], leaf: c.q });
  });

  it("a flipped signature byte, the wrong kind, the wrong payload, a clear leaf bit, another identity or creator: each a problem", () => {
    const flipped = vectorAuth();
    flipped.signature = Uint8Array.from(flipped.signature);
    flipped.signature[100] = flipped.signature[100]! ^ 1;
    const f = verifyAuthorization(flipped, ctx());
    expect(f.ok).toBe(false);
    expect(f.problems.join("\n")).toMatch(/does not verify|verifies at leaf/);

    expect(verifyAuthorization(vectorAuth(), { ...ctx(), expectedKind: 2 }).problems).toEqual([expect.stringMatching(/kind 1, expected 2/)]);
    expect(verifyAuthorization(vectorAuth(), { ...ctx(), expectedPayloadHash: new Uint8Array(32) }).problems).toEqual([expect.stringMatching(/payload hash differs/)]);
    expect(verifyAuthorization(vectorAuth(), { ...ctx(), identity: { lmsPublicKey: identity.publicKey, used: bitmapOf([]) } }).problems).toEqual([expect.stringMatching(/leaf 46 is not set/)]);
    const wrongId = verifyAuthorization(vectorAuth(), { ...ctx(), identity: { lmsPublicKey: other.publicKey, used: bitmapOf([c.q]) } });
    expect(wrongId.ok).toBe(false);
    expect(wrongId.problems.join("\n")).toMatch(/not this key's/);
    const wrongCreator = verifyAuthorization(vectorAuth(), { ...ctx(), launch: { publicKey: LAUNCH, creator: PAYER.publicKey, pqIdentity: identity.identityId } });
    expect(wrongCreator.problems.join("\n")).toMatch(/message hash/);
    const wrongKindByte = vectorAuth();
    wrongKindByte.kind = 2;
    expect(verifyAuthorization(wrongKindByte, ctx()).problems.join("\n")).toMatch(/canonical address/);
  });
});

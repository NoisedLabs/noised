/**
 * P1c (creator rules on-chain, attestation message v3, certificate v4,
 * policy v2, the 23-account launch) against the Rust vectors of
 * `vectors/programmable.json` (a byte copy of
 * tests/integration/vectors/programmable.json, written by
 * tests/integration/tests/programmable_vectors.rs and checked independently
 * by scripts/pq/lms_reference.py), plus the guards the SDK keeps around them:
 * byte parity of `publish_rules` and `attest_launch` with rules, the
 * `LaunchRules` record, the burn-only detection of unpublished or junk rules,
 * the leaf-ledger and pending-signature guards with rules, the transaction
 * sizes at the largest inputs, and mutation spot-checks of the decoders.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { fromHex, toHex } from "../src/codec/bytes.js";
import {
  CERTIFICATE,
  CERTIFICATE_ALL_CHECKS,
  CERTIFICATE_RULES_BOUND,
  certificateChecksComplete,
  HOOK_POLICY,
  LAUNCH_RULES,
  PQ_IDENTITY,
  PROGRAM_IDS,
} from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { certificateComplete, decodeAttestation, decodeCertificate, decodeHookPolicy, decodeLaunch, decodeLaunchRules, fetchLaunchRules } from "../src/launch/accounts.js";
import { getLaunchFlowStatus, planLaunch } from "../src/launch/flow.js";
import {
  buildPublishRulesTx,
  buildPublishRulesV1Tx,
  isLaunchRulesRecord,
  launchRulesSpace,
  PUBLISH_RULES_LEGACY_MAX_BYTES,
  publishRulesInstruction,
  publishRulesLegacySize,
  publishRulesV1Size,
  sendPublishRulesTx,
  type PublishRulesV1Ready,
} from "../src/launch/rules.js";
import { launchRulesAddress, launchRulesPda } from "../src/pda.js";
import { rulesHash, verifyRules } from "../src/programmable/index.js";
import {
  attestLaunchInstruction,
  attestTransactionSize,
  buildAttestLaunchTx,
  confirmAttestation,
  PendingAttestationError,
  sendAttestLaunchTx,
  type AttestLaunchReady,
  type BuildAttestLaunchArgs,
} from "../src/pq/attest.js";
import { attestationMessage, authorizationMessage, decodePqAttestEvent, deriveIdentity, parseAttestationMessage, type PqIdentity } from "../src/pq/identity.js";
import { createMemoryLeafLedger, launchSignatures, reserveAndSign } from "../src/pq/leafLedger.js";
import { lmsVerify } from "../src/pq/lms.js";
import { decodeV1Transaction } from "../src/tx/v1.js";
import { AttestConnection, emulateAttestLaunch, emulatedLaunchRulesBytes, emulatedRulesHash, emulateLaunchpad, emulatePublishRules, rulesPda } from "./attest_world.js";
import { readJson } from "./helpers.js";
import { accountBytes } from "./world.js";

interface Meta {
  readonly [k: string]: unknown;
}
interface ProgVectors {
  launch: {
    address: string;
    creator: string;
    data: string;
    guardSecs: number;
    landsAt: number;
    metadataHash: string;
    paramsHash: string;
    payer: string;
    pqIdentity: string;
    publicKey: string;
    slot: number;
    tokenMeta: string;
    tokenMetaData: string;
  };
  rules: {
    name: string;
    accountData: string;
    address: string;
    bump: number;
    bytes: string;
    len: number;
    rulesHash: string;
    rulesPublished: string;
    publishRules: { accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
  }[];
  attestation: {
    accountData: string;
    address: string;
    attestLaunch: { accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
    launchAttested: string;
    message: string;
    messageHash: string;
    notAfter: number;
    notBefore: number;
    q: number;
    rulesHash: string;
    signature: string;
  };
  authorizations: { cases: { kind: number; payloadHash: string; message: string }[] };
  parameters: Meta & {
    attestMessageLen: number;
    certificate: { accountLen: number; allChecks: number; checksOffset: number; metadataOffset: number; rulesBound: number; rulesHashOffset: number; version: number; withRules: number };
    hookPolicy: { rulesLenOffset: number; rulesOffset: number; version: number };
    launchRules: { fixedLen: number; offsets: Record<"bump" | "bytes" | "bytesLen" | "launch" | "rulesHash" | "version", number>; version: number };
    discriminators: Record<string, string>;
    rulesHashTag: string;
    noRulesHash: string;
  };
}

const V = readJson<ProgVectors>("./vectors/programmable.json");
const LMS = readJson<{ derivation: { master: string } }>("./vectors/lms.json");
const LAUNCH = new PublicKey(V.launch.address);
const CREATOR = new PublicKey(V.launch.creator);
const PAYER = new PublicKey(V.launch.payer);
const TYPICAL = V.rules[0]!;
const LARGEST = V.rules[1]!;
const TYPICAL_BYTES = fromHex(TYPICAL.bytes);
const LARGEST_BYTES = fromHex(LARGEST.bytes);
const WINDOW = { notBefore: BigInt(V.attestation.notBefore), notAfter: BigInt(V.attestation.notAfter) };
const keys = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) => ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }));
const verifier = (bytes: Uint8Array, guardSecs: number): boolean => verifyRules(bytes, { guardSecs }).ok;

let identity: PqIdentity;
beforeAll(async () => {
  identity = await deriveIdentity(fromHex(LMS.derivation.master), "localnet", 0);
});

/** The vector launch (Configured, names the vector identity, guard 3,600 s), its metadata record published, at the vector's landing time. */
function world(): AttestConnection {
  const conn = new AttestConnection();
  conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: fromHex(V.launch.data) });
  conn.set(new PublicKey(V.launch.tokenMeta), { owner: PROGRAM_IDS.launchpad, data: fromHex(V.launch.tokenMetaData) });
  conn.setClock(BigInt(V.launch.landsAt));
  conn.land = (w) => emulateLaunchpad(conn, w, verifier);
  return conn;
}

function publishTypical(conn: AttestConnection, bytes: Uint8Array = TYPICAL_BYTES): PublicKey {
  const [address] = rulesPda(LAUNCH, emulatedRulesHash(bytes));
  conn.set(address, { owner: PROGRAM_IDS.launchpad, data: emulatedLaunchRulesBytes(LAUNCH, bytes) });
  return address;
}

function attestArgs(ledger: ReturnType<typeof createMemoryLeafLedger>, over: Partial<BuildAttestLaunchArgs> = {}): BuildAttestLaunchArgs {
  return {
    launch: LAUNCH,
    creator: CREATOR,
    identity,
    ledger,
    metadataHash: fromHex(V.launch.metadataHash),
    rulesHash: fromHex(TYPICAL.rulesHash),
    window: WINDOW,
    payer: Keypair.generate(),
    allowLocalnet: true,
    landingMarginSecs: 0n,
    expectedParamsHash: fromHex(V.launch.paramsHash),
    ...over,
  } as BuildAttestLaunchArgs;
}

const fund = (conn: AttestConnection, payer: PublicKey, lamports: bigint): void => {
  conn.set(payer, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(lamports) });
};

// ------------------------------------------------------------- constants ---

describe("P1c constants equal the vectors' parameters", () => {
  it("certificate v4, the rules record, the policy v2, the message v3, the discriminators", () => {
    const P = V.parameters;
    expect(P.certificate).toEqual({
      accountLen: CERTIFICATE.ACCOUNT_LEN,
      allChecks: CERTIFICATE_ALL_CHECKS,
      checksOffset: CERTIFICATE.CHECKS_OFFSET,
      metadataOffset: CERTIFICATE.METADATA_OFFSET,
      rulesBound: CERTIFICATE_RULES_BOUND,
      rulesHashOffset: CERTIFICATE.RULES_HASH_OFFSET,
      version: CERTIFICATE.VERSION,
      withRules: CERTIFICATE_ALL_CHECKS | CERTIFICATE_RULES_BOUND,
    });
    const o = LAUNCH_RULES.OFFSETS;
    expect(P.launchRules).toEqual({ fixedLen: LAUNCH_RULES.FIXED_LEN, offsets: { bump: o.BUMP, bytes: o.BYTES, bytesLen: o.LEN, launch: o.LAUNCH, rulesHash: o.RULES_HASH, version: o.VERSION }, version: LAUNCH_RULES.VERSION });
    expect(P.hookPolicy).toMatchObject({ rulesLenOffset: HOOK_POLICY.RULES_LEN_OFFSET, rulesOffset: HOOK_POLICY.RULES_OFFSET, version: HOOK_POLICY.VERSION });
    expect([P.attestMessageLen, P.rulesHashTag, P.noRulesHash]).toEqual([PQ_IDENTITY.ATTEST_MESSAGE_LEN, LAUNCH_RULES.HASH_TAG, "00".repeat(32)]);
    expect(P.discriminators["launchRules"]).toBe(toHex(Uint8Array.from(LAUNCH_RULES.DISCRIMINATOR)));
    expect(P.discriminators["hookPolicy"]).toBe(toHex(Uint8Array.from(HOOK_POLICY.DISCRIMINATOR)));
    expect(P.discriminators["publishRules"]).toBe(toHex(Uint8Array.from(idlCodecs().launchpad.instruction("publish_rules").discriminator)));
    expect(P.discriminators["rulesPublished"]).toBe(toHex(Uint8Array.from(idlCodecs().launchpad.idl.events!.find((e) => e.name === "RulesPublished")!.discriminator)));
    expect(P.discriminators["launchAttested"]).toBe(toHex(Uint8Array.from(idlCodecs().launchpad.idl.events!.find((e) => e.name === "LaunchAttested")!.discriminator)));
  });

  it("every consumer tests (checks & 4095) == 4095, never checks == 4095 (no such comparison in src/)", () => {
    expect([4095, 8191].map(certificateChecksComplete)).toEqual([true, true]);
    expect([4094, 4096, 0, 8190, 4095.5].map(certificateChecksComplete)).toEqual([false, false, false, false, false]);
    expect(certificateComplete({ checks: 8191 })).toBe(true);
    // Scan the SDK's sources for an equality test of `checks` against the twelve bits.
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const bad = /\bchecks\s*[!=]==?\s*(4095|4_095|CERTIFICATE_ALL_CHECKS|QSL1\.ALL_CHECKS|ALL_CHECKS)\b|\b(4095|4_095|CERTIFICATE_ALL_CHECKS|ALL_CHECKS)\s*[!=]==?\s*[\w.]*checks\b/;
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ f, i, line }))
        .filter(({ line }) => bad.test(line) && !/^\s*(\*|\/\/)/.test(line)),
    );
    expect(hits.map((h) => `${h.f}:${h.i + 1}: ${h.line.trim()}`)).toEqual([]);
  });
});

// --------------------------------------------------------- publish_rules ---

describe("publish_rules (vectors: rules)", () => {
  it("instruction data and accounts equal the Rust vector, for the typical and the largest rule set", () => {
    for (const r of V.rules) {
      const bytes = fromHex(r.bytes);
      expect(bytes.length, r.name).toBe(r.len);
      expect(toHex(rulesHash(bytes)), r.name).toBe(r.rulesHash);
      expect(toHex(emulatedRulesHash(bytes)), r.name).toBe(r.rulesHash);
      const ix = publishRulesInstruction(PAYER, LAUNCH, bytes);
      expect(toHex(ix.data), r.name).toBe(r.publishRules.data);
      expect(keys(ix), r.name).toEqual(r.publishRules.accounts);
      expect(launchRulesAddress(LAUNCH, bytes.length > 0 ? fromHex(r.rulesHash) : new Uint8Array(32)).toBase58(), r.name).toBe(r.address);
      expect(launchRulesPda(LAUNCH, fromHex(r.rulesHash))[1], r.name).toBe(r.bump);
      expect(verifyRules(bytes, { guardSecs: V.launch.guardSecs }).ok, r.name).toBe(true);
    }
    expect(LARGEST.len).toBe(LAUNCH_RULES.MAX_RULES_LEN);
    expect(() => launchRulesAddress(LAUNCH, new Uint8Array(32))).toThrow(/no rules/);
  });

  it("the LaunchRules record decodes at its documented offsets (78 + len bytes); the model writes the same bytes", () => {
    for (const r of V.rules) {
      const data = fromHex(r.accountData);
      expect(data.length, r.name).toBe(launchRulesSpace(r.len));
      expect(toHex(emulatedLaunchRulesBytes(LAUNCH, fromHex(r.bytes))), r.name).toBe(r.accountData);
      const rec = decodeLaunchRules(new PublicKey(r.address), data);
      expect([rec.version, rec.bump, rec.launch.toBase58(), toHex(rec.rulesHash), toHex(rec.bytes)], r.name).toEqual([1, r.bump, V.launch.address, r.rulesHash, r.bytes]);
      expect(isLaunchRulesRecord({ address: new PublicKey(r.address), owner: PROGRAM_IDS.launchpad, lamports: 1, executable: false, data }, LAUNCH, fromHex(r.rulesHash)), r.name).toBe(true);
      // The RulesPublished event.
      const ev = idlCodecs().launchpad.decodeType<{ launch: PublicKey; rules: PublicKey; rulesHash: Uint8Array; len: number }>("RulesPublished", fromHex(r.rulesPublished));
      expect([ev.launch.toBase58(), ev.rules.toBase58(), toHex(ev.rulesHash), ev.len], r.name).toEqual([V.launch.address, r.address, r.rulesHash, r.len]);
      const disc = idlCodecs().launchpad.idl.events!.find((e) => e.name === "RulesPublished")!.discriminator;
      const decoded = decodePqAttestEvent(Uint8Array.from([...disc, ...fromHex(r.rulesPublished)]));
      expect(decoded?.name).toBe("RulesPublished");
    }
  });

  it("mutation spot-checks: any changed fixed field, a short or long account, or another owner is not the record", () => {
    const data = fromHex(TYPICAL.accountData);
    const address = new PublicKey(TYPICAL.address);
    const hash = fromHex(TYPICAL.rulesHash);
    const raw = (d: Uint8Array, owner = PROGRAM_IDS.launchpad) => ({ address, owner, lamports: 1, executable: false, data: d });
    for (const at of [0, 8, 9, 10, 41, 42, 73]) {
      const m = Uint8Array.from(data);
      m[at]! ^= 1;
      expect(isLaunchRulesRecord(raw(m), LAUNCH, hash), `byte ${at}`).toBe(false);
      expect(() => decodeLaunchRules(address, m), `byte ${at}`).toThrow();
    }
    // A changed rule byte: the stored hash no longer matches the bytes (the program never writes that).
    const body = Uint8Array.from(data);
    body[100]! ^= 1;
    expect(() => decodeLaunchRules(address, body)).toThrow(/do not hash/);
    expect(() => decodeLaunchRules(address, Uint8Array.from([...data, 0]))).toThrow(/bytes, expected/);
    expect(isLaunchRulesRecord(raw(data, SystemProgram.programId), LAUNCH, hash)).toBe(false);
    expect(isLaunchRulesRecord(raw(data.subarray(0, 77)), LAUNCH, hash)).toBe(false);
    expect(isLaunchRulesRecord(null, LAUNCH, hash)).toBe(false);
    expect(() => decodeLaunchRules(new PublicKey(LARGEST.address), data)).toThrow(/not at the address/);
  });

  it("sizes at the largest inputs: legacy up to PUBLISH_RULES_LEGACY_MAX_BYTES (1,232 B with both compute-budget instructions); v1 for any set (<= 4,096 B)", () => {
    expect(publishRulesLegacySize(PUBLISH_RULES_LEGACY_MAX_BYTES)).toBe(1_232);
    expect(publishRulesLegacySize(PUBLISH_RULES_LEGACY_MAX_BYTES + 1)).toBe(1_233);
    expect(publishRulesLegacySize(TYPICAL.len)).toBeLessThanOrEqual(1_232);
    expect(publishRulesLegacySize(LARGEST.len)).toBeGreaterThan(1_232);
    expect(publishRulesV1Size(LARGEST.len, { priorityFee: true })).toBeLessThanOrEqual(4_096);
    expect(publishRulesV1Size(LARGEST.len) + 8).toBe(publishRulesV1Size(LARGEST.len, { priorityFee: true }));
    // attest_launch with rules: one more account than without, still far under 4,096 B.
    expect(attestTransactionSize({ rules: true, priorityFee: true })).toBe(attestTransactionSize({ priorityFee: true }) + 32);
    expect(attestTransactionSize({ rules: true, priorityFee: true })).toBeLessThanOrEqual(4_096);
  });

  it("buildPublishRulesV1Tx: verified for the launch's guard, landed by the model, the record the Rust bytes; idempotent", async () => {
    const conn = world();
    const payer = Keypair.generate();
    fund(conn, payer.publicKey, 100_000_000n);
    for (const r of [TYPICAL, LARGEST]) {
      const built = await buildPublishRulesV1Tx(conn.asConnection(), payer, { launch: LAUNCH, rules: fromHex(r.bytes) });
      expect(built.status).toBe("ready");
      const b = built as PublishRulesV1Ready;
      expect(b.sizeBytes).toBeLessThanOrEqual(4_096);
      expect(b.sizeBytes).toBe(publishRulesV1Size(r.len));
      expect(b.rules.toBase58()).toBe(r.address);
      expect(b.rentLamports).toBe(BigInt((128 + 78 + r.len) * 6_960));
      const d = decodeV1Transaction(b.tx);
      expect(toHex(d.instructions[0]!.data)).toBe(toHex(publishRulesInstruction(payer.publicKey, LAUNCH, fromHex(r.bytes)).data));
      const rec = await sendPublishRulesTx(conn.asConnection(), b);
      expect(toHex(conn.get(rec.publicKey)!.data)).toBe(r.accountData);
      const again = await buildPublishRulesV1Tx(conn.asConnection(), payer, { launch: LAUNCH, rules: fromHex(r.bytes) });
      expect(again.status).toBe("already-published");
    }
    expect((await fetchLaunchRules(conn.asConnection(), LAUNCH, fromHex(TYPICAL.rulesHash)))?.bytes).toEqual(TYPICAL_BYTES);
    expect(await fetchLaunchRules(conn.asConnection(), LAUNCH, new Uint8Array(32))).toBeNull();
  });

  it("refuses what the program refuses: rules that do not verify for the guard (InvalidRules 6048), a live or missing launch, too large for legacy", async () => {
    const conn = world();
    const payer = Keypair.generate();
    // The vector launch's guard is 3,600 s: a launch whose guard is shorter than the rules' windows refuses them.
    const l = decodeLaunch(LAUNCH, fromHex(V.launch.data));
    const short = idlCodecs().launchpad.decodeAccount<Record<string, unknown>>("Launch", fromHex(V.launch.data));
    conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Launch", { ...short, guardSecs: 60 }) });
    expect(verifyRules(TYPICAL_BYTES, { guardSecs: 60 }).ok).toBe(false);
    await expect(buildPublishRulesV1Tx(conn.asConnection(), payer, { launch: LAUNCH, rules: TYPICAL_BYTES })).rejects.toThrow(/InvalidRules \(6048\)/);
    expect(() => emulatePublishRules(conn, new Uint8Array(0), verifier)).toThrow();
    conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Launch", { ...short, status: { kind: "Live" } }) });
    await expect(buildPublishRulesV1Tx(conn.asConnection(), payer, { launch: LAUNCH, rules: TYPICAL_BYTES })).rejects.toThrow(/WrongLaunchState/);
    await expect(buildPublishRulesV1Tx(world().asConnection(), payer, { launch: PAYER, rules: TYPICAL_BYTES })).rejects.toThrow(/does not exist/);
    await expect(buildPublishRulesTx(world().asConnection(), PAYER, { launch: LAUNCH, rules: LARGEST_BYTES })).rejects.toThrow(/buildPublishRulesV1Tx/);
    const legacy = await buildPublishRulesTx(world().asConnection(), PAYER, { launch: LAUNCH, rules: TYPICAL_BYTES, computeUnitPrice: 1n });
    expect(legacy.status === "ready" && legacy.sizeBytes).toBe(publishRulesLegacySize(TYPICAL.len));
    await expect(buildPublishRulesV1Tx(world().asConnection(), payer, { launch: LAUNCH, rules: new Uint8Array(0) })).rejects.toThrow(/empty rules/);
    expect(l.guardSecs).toBe(V.launch.guardSecs);
  });
});

// ------------------------------------------------- attestation message v3 ---

describe("attest_launch with creator rules (vectors: attestation)", () => {
  it("message v3, its hash, the deterministic signature at the vector's leaf, the instruction (7 accounts, the rules record last) and the account", () => {
    const l = decodeLaunch(LAUNCH, fromHex(V.launch.data));
    const message = attestationMessage({ launch: LAUNCH, paramsHash: l.paramsHash, creator: l.creator, metadataHash: fromHex(V.launch.metadataHash), rulesHash: fromHex(V.attestation.rulesHash), ...WINDOW });
    expect(toHex(message)).toBe(V.attestation.message);
    expect(message).toHaveLength(221);
    expect(toHex(sha256(message))).toBe(V.attestation.messageHash);
    expect(toHex(parseAttestationMessage(message).rulesHash)).toBe(TYPICAL.rulesHash);
    expect(V.attestation.rulesHash).toBe(TYPICAL.rulesHash);
    expect(toHex(identity.keyPair.publicKey)).toBe(V.launch.publicKey);
    expect(lmsVerify(identity.keyPair.publicKey, message, fromHex(V.attestation.signature))).toBe(V.attestation.q);
    const ix = attestLaunchInstruction({
      payer: PAYER,
      launch: LAUNCH,
      lmsPublicKey: identity.keyPair.publicKey,
      lmsSignature: fromHex(V.attestation.signature),
      metadataHash: fromHex(V.launch.metadataHash),
      rulesHash: fromHex(V.attestation.rulesHash),
      ...WINDOW,
    });
    expect(toHex(ix.data)).toBe(V.attestation.attestLaunch.data);
    expect(keys(ix)).toEqual(V.attestation.attestLaunch.accounts);
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(TYPICAL.address);
    const a = decodeAttestation(new PublicKey(V.attestation.address), fromHex(V.attestation.accountData));
    expect([a.version, a.attested, a.leaf, toHex(a.rulesHash), toHex(a.messageHash), a.notBefore, a.notAfter]).toEqual([
      3,
      true,
      V.attestation.q,
      TYPICAL.rulesHash,
      V.attestation.messageHash,
      WINDOW.notBefore,
      WINDOW.notAfter,
    ]);
    expect(fromHex(V.attestation.accountData)).toHaveLength(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN);
    // LaunchAttested carries the rules hash after the metadata hash.
    const ev = idlCodecs().launchpad.decodeType<{ rulesHash: Uint8Array; metadataHash: Uint8Array; leaf: number }>("LaunchAttested", fromHex(V.attestation.launchAttested));
    expect([toHex(ev.rulesHash), toHex(ev.metadataHash), ev.leaf]).toEqual([TYPICAL.rulesHash, V.launch.metadataHash, V.attestation.q]);
    const disc = idlCodecs().launchpad.idl.events!.find((e) => e.name === "LaunchAttested")!.discriminator;
    const decoded = decodePqAttestEvent(Uint8Array.from([...disc, ...fromHex(V.attestation.launchAttested)]));
    expect(decoded?.name === "LaunchAttested" && toHex(decoded.rulesHash)).toBe(TYPICAL.rulesHash);
    // A v2 (189-byte, no rules hash) attestation account decodes as not attested: launch would refuse it.
    const v2 = Uint8Array.from(fromHex(V.attestation.accountData));
    v2[8] = 2;
    expect(decodeAttestation(new PublicKey(V.attestation.address), v2).attested).toBe(false);
  });

  it("buildAttestLaunchTx with rules: the vector's leaf and bytes; lands and attests with the rules hash; the rules record is required, final and valid", async () => {
    const conn = world();
    const ledger = createMemoryLeafLedger();
    // No rules record: refused before anything is reserved or signed (it would only burn the leaf).
    await expect(buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger))).rejects.toThrow(/no valid rules record is published/);
    expect(await ledger.list(identity.identityId)).toEqual([]);
    // Lamports someone sent to the record's address are not a record.
    const address = new PublicKey(TYPICAL.address);
    conn.set(address, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 1_000_000 });
    await expect(buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger))).rejects.toThrow(/no valid rules record/);
    // Published but not final yet.
    publishTypical(conn);
    conn.hiddenAtFinalized.add(TYPICAL.address);
    await expect(buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger))).rejects.toThrow(/rules record is not finalized yet/);
    conn.hiddenAtFinalized.delete(TYPICAL.address);
    expect(await ledger.list(identity.identityId)).toEqual([]);

    // The vector's leaf: a ledger that assigned this message there (the SDK's own choice is the secret probe, audit 4 ID-F1a).
    expect(await ledger.reserve(identity.identityId, V.attestation.q, sha256(fromHex(V.attestation.message)), { launch: LAUNCH })).toBe("reserved");
    const built = await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger));
    expect(built.status).toBe("ready");
    const r = built as AttestLaunchReady;
    expect(toHex(r.message)).toBe(V.attestation.message);
    expect(r.leaf).toBe(V.attestation.q);
    expect(toHex(r.lmsSignature)).toBe(V.attestation.signature);
    expect(r.rules?.toBase58()).toBe(TYPICAL.address);
    expect(toHex(r.rulesHash)).toBe(TYPICAL.rulesHash);
    expect(r.sizeBytes).toBe(attestTransactionSize({ rules: true }));
    const d = decodeV1Transaction(r.tx);
    expect(toHex(d.instructions[0]!.data)).toBe(V.attestation.attestLaunch.data);
    // Recorded with its rules hash (read from the signed bytes).
    expect((await launchSignatures(ledger, identity.identityId, LAUNCH)).map((s) => toHex(s.rulesHash))).toEqual([TYPICAL.rulesHash]);
    fund(conn, r.payer.publicKey, r.fundingLamports);
    const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
    expect(out.status).toBe("attested");
    const stored = decodeAttestation(new PublicKey(V.attestation.address), conn.get(new PublicKey(V.attestation.address))!.data);
    expect([stored.version, toHex(stored.rulesHash), toHex(stored.messageHash)]).toEqual([3, TYPICAL.rulesHash, V.attestation.messageHash]);
    // The account the model wrote is the Rust account, byte for byte (the clock's slot is the vector's).
    expect(toHex(conn.get(new PublicKey(V.attestation.address))!.data)).toBe(V.attestation.accountData);
  });

  it("burn-only detection: a signature naming unpublished or junk rules lands only to burn its leaf, and says why", async () => {
    // Rules that were never published (the emulated program attests only a record that exists).
    const conn = world();
    const ledger = createMemoryLeafLedger();
    publishTypical(conn);
    const r = (await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger))) as AttestLaunchReady;
    // The record vanishes from the RPC's view before the landing (a dropped fork): the landing only burns.
    conn.delete(new PublicKey(TYPICAL.address));
    fund(conn, r.payer.publicKey, r.fundingLamports);
    const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
    expect(out.status).toBe("burned");
    expect(out.status === "burned" && out.reasons).toEqual(["rules-missing"]);
    expect(out.status === "burned" && out.detail).toMatch(/launch rules it names were not published/);
    // Junk at the address (lamports only): the same verdict, and nothing else reported.
    conn.set(new PublicKey(TYPICAL.address), { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 5_000_000 });
    const again = await confirmAttestation(conn.asConnection(), LAUNCH, r.messageHash, { leaf: r.leaf, lmsPublicKey: identity.keyPair.publicKey, message: r.message, landedAt: BigInt(V.launch.landsAt) });
    expect(again.status === "burned" && again.reasons).toEqual(["rules-missing"]);
    // A wrong rules account fails ConstraintSeeds in the model (nothing burned): the program refuses any other address.
    const wrong = attestLaunchInstruction({ payer: PAYER, launch: LAUNCH, lmsPublicKey: identity.keyPair.publicKey, lmsSignature: r.lmsSignature, metadataHash: r.metadataHash, rulesHash: new Uint8Array(32), ...WINDOW });
    expect(wrong.keys[6]!.pubkey.equals(PROGRAM_IDS.launchpad)).toBe(true);
  });

  it("the pending-signature guard holds with rules: an earlier signature of the launch that can still land blocks a new message", async () => {
    const conn = world();
    publishTypical(conn);
    const ledger = createMemoryLeafLedger();
    // Signed (rules included) but never sent.
    const first = (await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger))) as AttestLaunchReady;
    expect(first.status).toBe("ready");
    const other = { notBefore: WINDOW.notBefore + 600n, notAfter: WINDOW.notAfter + 600n };
    await expect(buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, { window: other }))).rejects.toBeInstanceOf(PendingAttestationError);
    // A rebuild of the recorded signature is never refused, and gives the same bytes.
    const again = (await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger))) as AttestLaunchReady;
    expect([again.leaf, toHex(again.lmsSignature), again.retry]).toEqual([first.leaf, toHex(first.lmsSignature), true]);
    // Without rules, the same window is another message: also refused while the first can land.
    await expect(buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, { rulesHash: new Uint8Array(32) }))).rejects.toBeInstanceOf(PendingAttestationError);
  });

  it("the leaf ledger: an authorization (PHX-AUTH-V1) the identity signed for the launch is neither a pending attestation nor a burn-only landing", async () => {
    const conn = world();
    publishTypical(conn);
    const ledger = createMemoryLeafLedger();
    const auth = authorizationMessage({ launch: LAUNCH, creator: CREATOR, kind: 1, payloadHash: fromHex(V.authorizations.cases[0]!.payloadHash) });
    expect(toHex(auth)).toBe(V.authorizations.cases[0]!.message);
    // Signed at some leaf and recorded as landed without "attesting" (an authorization does not attest).
    await reserveAndSign(ledger, identity.keyPair, 3, auth, { launch: LAUNCH });
    await ledger.markLanded(identity.identityId, 3, { attested: false });
    await reserveAndSign(ledger, identity.keyPair, 4, authorizationMessage({ launch: LAUNCH, creator: CREATOR, kind: 2, payloadHash: new Uint8Array(32).fill(5) }), { launch: LAUNCH });
    await ledger.markLanded(identity.identityId, 4, { attested: false });
    expect(await launchSignatures(ledger, identity.identityId, LAUNCH)).toEqual([]);
    // maxBurnOnlyLandings 0 would refuse at the first burn-only attestation landing; authorizations do not count.
    const built = await buildAttestLaunchTx(conn.asConnection(), attestArgs(ledger, { maxBurnOnlyLandings: 1 }));
    expect(built.status).toBe("ready");
    // The leaves an authorization used are never reused by an attestation.
    expect([3, 4]).not.toContain((built as AttestLaunchReady).leaf);
  });

  it("planLaunch with rules: verified for the guard, explained in plain English, hashed into message v3", () => {
    const l = decodeLaunch(LAUNCH, fromHex(V.launch.data));
    const base = { creator: CREATOR, identity: identity.identityId, recipients: [{ wallet: CREATOR, bps: 10_000 }], metadata: { name: "Rules", symbol: "RUL" }, opensAt: 1_767_225_600n };
    const plan = planLaunch({ ...base, preset: "turbo", rules: TYPICAL_BYTES });
    expect(plan.params.guardSecs).toBe(l.guardSecs);
    expect(toHex(plan.rulesHash)).toBe(TYPICAL.rulesHash);
    expect(plan.rulesRecord?.equals(launchRulesAddress(plan.launch, plan.rulesHash))).toBe(true);
    expect(plan.rulesExplanation.length).toBeGreaterThan(0);
    expect(toHex(parseAttestationMessage(plan.message).rulesHash)).toBe(TYPICAL.rulesHash);
    // The fair preset's guard (6 h) also accepts them; a set whose window passes the guard does not verify.
    expect(planLaunch({ ...base, rules: TYPICAL_BYTES }).rules).not.toBeNull();
    const longGuardOnly = planLaunch({ ...base, rules: LARGEST_BYTES });
    expect(longGuardOnly.rules?.length).toBe(LAUNCH_RULES.MAX_RULES_LEN);
    const shortGuard = { ...base, params: { ...planLaunch({ ...base, preset: "turbo" }).params, guardSecs: 600 } };
    const { recipients: _r, pqIdentity: _p, ...withoutRecipients } = shortGuard.params;
    expect(() => planLaunch({ ...base, params: withoutRecipients, rules: TYPICAL_BYTES })).toThrow(/rules: they do not verify/);
    expect(planLaunch({ ...base, rules: new Uint8Array(0) }).rules).toBeNull();
  });
});

describe("getLaunchFlowStatus with creator rules", () => {
  it("publish until the rules record exists; then attest; the attested rules hash is followed afterwards", async () => {
    const conn = world();
    const c = conn.asConnection();
    const opts = { expectedMetadataHash: fromHex(V.launch.metadataHash), expectedRulesHash: fromHex(TYPICAL.rulesHash), nowSecs: BigInt(V.launch.landsAt) };
    let s = await getLaunchFlowStatus(c, LAUNCH, opts);
    expect([s.step, s.metadataPublished, s.rulesPublished]).toEqual(["publish", true, false]);
    expect(s.summary).toMatch(/publish the launch rules/);
    publishTypical(conn);
    s = await getLaunchFlowStatus(c, LAUNCH, opts);
    expect([s.step, s.rulesPublished]).toEqual(["attest", true]);
    expect((await getLaunchFlowStatus(c, LAUNCH, { ...opts, expectedRulesHash: new Uint8Array(32) })).rulesPublished).toBeNull();
    await expect(getLaunchFlowStatus(c, LAUNCH, { ...opts, expectedRulesHash: new Uint8Array(31) })).rejects.toThrow(/32 bytes/);
    // Attested (the vector account): the attested rules hash is the one followed.
    conn.set(new PublicKey(V.attestation.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(V.attestation.accountData) });
    s = await getLaunchFlowStatus(c, LAUNCH, { nowSecs: BigInt(V.launch.landsAt) });
    expect([s.step, s.rulesPublished]).toEqual(["launch", true]);
  });
});

// --------------------------------------------------- certificate v4, policy ---

describe("certificate v4 and v3, hook policy v2", () => {
  it("decodeCertificate reads 519-byte v4 (rules_hash at 487) and 487-byte v3 (no rules); anything else is refused", () => {
    const codec = idlCodecs().launchpad;
    const zero = codec.decodeAccount<Record<string, unknown>>("Certificate", new Uint8Array([...codec.accountDiscriminator("Certificate"), ...new Uint8Array(CERTIFICATE.ACCOUNT_LEN - 8)]));
    const hash = fromHex(TYPICAL.rulesHash);
    const v4 = accountBytes("launchpad", "Certificate", { ...zero, version: 4, checks: 8191, rulesHash: hash });
    expect(v4).toHaveLength(519);
    expect(toHex(v4.subarray(CERTIFICATE.RULES_HASH_OFFSET))).toBe(TYPICAL.rulesHash);
    const c4 = decodeCertificate(PAYER, v4);
    expect([c4.version, c4.checks, toHex(c4.rulesHash), certificateComplete(c4)]).toEqual([4, 8191, TYPICAL.rulesHash, true]);
    const v3 = Uint8Array.from(v4.subarray(0, CERTIFICATE.V3_ACCOUNT_LEN));
    v3[8] = 3;
    v3.set([0xff, 0x0f, 0, 0], CERTIFICATE.CHECKS_OFFSET);
    const c3 = decodeCertificate(PAYER, v3);
    expect([c3.version, c3.checks, toHex(c3.rulesHash), certificateComplete(c3)]).toEqual([3, 4095, "00".repeat(32), true]);
    const wrong = Uint8Array.from(v4);
    wrong[8] = 3;
    expect(() => decodeCertificate(PAYER, wrong)).toThrow(/version 3 and 519 bytes/);
    const v5 = Uint8Array.from(v4);
    v5[8] = 5;
    expect(() => decodeCertificate(PAYER, v5)).toThrow(/version 5/);
    expect(() => decodeCertificate(PAYER, v4.subarray(0, 500))).toThrow();
  });

  it("decodeHookPolicy: the rules after the fixed fields (u32 length at 275, bytes from 279), exactly 279 + len bytes", () => {
    const policy = {
      version: 2,
      bump: 250,
      mint: PAYER,
      pool: LAUNCH,
      baseVault: CREATOR,
      launchTs: 1n,
      snipeShieldEndTs: 2n,
      guardEndTs: 3n,
      maxWallet: 4n,
      maxBuy: 5n,
      p2pLocked: false,
      exempt: [PAYER, LAUNCH, PublicKey.default, PublicKey.default],
      rules: TYPICAL_BYTES,
    };
    const data = accountBytes("hook", "HookPolicy", policy);
    expect(data).toHaveLength(HOOK_POLICY.BASE_LEN + TYPICAL.len);
    expect(new DataView(data.buffer, data.byteOffset).getUint32(HOOK_POLICY.RULES_LEN_OFFSET, true)).toBe(TYPICAL.len);
    expect(toHex(data.subarray(HOOK_POLICY.RULES_OFFSET))).toBe(TYPICAL.bytes);
    const p = decodeHookPolicy(PAYER, data);
    expect(toHex(p.rules)).toBe(TYPICAL.bytes);
    expect(decodeHookPolicy(PAYER, accountBytes("hook", "HookPolicy", { ...policy, rules: new Uint8Array(0) })).rules).toHaveLength(0);
    expect(() => decodeHookPolicy(PAYER, accountBytes("hook", "HookPolicy", { ...policy, version: 1 }))).toThrow(/version 1/);
    expect(() => decodeHookPolicy(PAYER, Uint8Array.from([...data, 0]))).toThrow(/bytes, expected/);
  });
});

/** Keep the model's attest emulation reachable for readers of this file. */
export const models = { emulateAttestLaunch };

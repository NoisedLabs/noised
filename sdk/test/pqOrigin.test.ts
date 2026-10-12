/**
 * `checkPqOrigin` and `verifyAttestation` (src/verify/pqOrigin.ts) on the
 * Rust-produced accounts of `vectors/lms.json` (message v3, attestation v3,
 * no rules): the Attestation, Identity and TokenMeta accounts the launchpad
 * writes, the Launch account they attest, the 221-byte message, the five
 * deterministic signatures and the burn-only empty attestation. Then every
 * mismatch that must turn the origin into "not PQ-attested", the metadata
 * record included. The attestation of `vectors/programmable.json`, which
 * signs creator rules, is in test/verify_rules.test.ts.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, u32le, utf8 } from "../src/codec/bytes.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS } from "../src/constants.js";
import { decodeLaunch } from "../src/launch/accounts.js";
import { attestationAddress, identityAddressFromId, tokenMetaAddress } from "../src/pda.js";
import type { RawAccount } from "../src/rpc/fetch.js";
import type { CertificateAccount, LaunchAccount } from "../src/types.js";
import { checkPqOrigin, tokenMetadataFields, verifyAttestation, type PqOriginInputs } from "../src/verify/pqOrigin.js";
import { ext, key, MockConnection } from "./helpers.js";
import { identityBytes, LMS } from "./verifyFixtures.js";

const A = LMS.attestation;
const launchKey = new PublicKey(A.launch);
const identityId = fromHex(LMS.identity.identityId);
const recordKey = new PublicKey(LMS.accounts.tokenMeta.address);

const raw = (address: PublicKey, data: Uint8Array, owner: PublicKey = PROGRAM_IDS.launchpad): RawAccount => ({ address, owner, lamports: 1, executable: false, data });
const attestationData = (): Uint8Array => fromHex(LMS.accounts.attestation.data);
const identityData = (): Uint8Array => fromHex(LMS.accounts.identity.data);
const recordData = (): Uint8Array => fromHex(LMS.accounts.tokenMeta.data);
/** What `launch` gives the mint for the vector record (no uri mode): its name, its symbol, the empty uri, no additional metadata. */
const mintMetadata = () => ({ name: utf8(LMS.metadata.name), symbol: utf8(LMS.metadata.symbol), uri: new Uint8Array(0), additional: u32le(0) });

/** Valid inputs: the vector launch, attested at leaf 511 in slot 400,000,000, launched when its window opened. */
function inputs(): PqOriginInputs & { certificate: CertificateAccount; launch: LaunchAccount } {
  const launch = decodeLaunch(launchKey, fromHex(LMS.accounts.launch.data));
  const certificate = {
    launch: launchKey,
    paramsHash: launch.paramsHash,
    creator: launch.creator,
    pqIdentity: identityId,
    pqLeaf: LMS.accounts.attestation.leaf,
    attestedSlot: BigInt(LMS.accounts.attestation.slot),
    launchedAt: BigInt(A.notBefore),
    metadata: recordKey,
    rulesHash: new Uint8Array(32),
  } as CertificateAccount;
  return {
    certificate,
    launch,
    attestation: raw(new PublicKey(LMS.accounts.attestation.address), attestationData()),
    identity: raw(new PublicKey(LMS.accounts.identity.address), identityData()),
    tokenMeta: raw(recordKey, recordData()),
    metadata: mintMetadata(),
  };
}

function problemsOf(i: PqOriginInputs): string {
  const r = checkPqOrigin(i);
  expect(r.origin?.verified ?? false).toBe(false);
  expect(r.problems.length).toBeGreaterThan(0);
  return r.problems.join("; ");
}

describe("checkPqOrigin on the Rust vectors", () => {
  it("re-verifies the launchpad's attestation: the rebuilt message is the vector's, the record hashes to the signed hash, the signature verifies at leaf 511", () => {
    const i = inputs();
    // The vector's own consistency: launch, identity, attestation and record addresses.
    expect(attestationAddress(launchKey).toBase58()).toBe(A.attestationAccount);
    expect(identityAddressFromId(identityId).toBase58()).toBe(LMS.identity.identityAccount);
    expect(tokenMetaAddress(launchKey, fromHex(A.metadataHash)).toBase58()).toBe(LMS.metadata.tokenMetaAccount);
    expect(toHex(i.launch.paramsHash)).toBe(A.paramsHash);
    expect(i.launch.creator.toBase58()).toBe(A.creator);
    const r = checkPqOrigin(i);
    expect(r.problems).toEqual([]);
    expect(toHex(r.message!)).toBe(A.message);
    expect(r.message).toHaveLength(221);
    expect(A.rulesHash).toBe("0".repeat(64));
    const o = r.origin!;
    expect(o.verified).toBe(true);
    expect(o.signatureValid).toBe(true);
    expect(o.attestation.toBase58()).toBe(A.attestationAccount);
    expect(o.identity.toBase58()).toBe(LMS.identity.identityAccount);
    expect(toHex(o.identityId)).toBe(LMS.identity.identityId);
    expect(toHex(o.lmsPublicKey!)).toBe(LMS.identity.publicKey);
    expect(o.leaf).toBe(511);
    expect(o.attestationSlot).toBe(400_000_000n);
    expect(toHex(o.messageHash)).toBe(A.messageHash);
    expect(o.window).toEqual({ notBefore: BigInt(A.notBefore), notAfter: BigInt(A.notAfter) });
    expect(toHex(o.metadataHash)).toBe(A.metadataHash);
    expect(o.tokenMeta.toBase58()).toBe(LMS.metadata.tokenMetaAccount);
    expect(r.record?.name).toBe(LMS.metadata.name);
    expect(new TextDecoder().decode(r.record!.doc)).toBe(LMS.metadata.doc);
    // No rules: the all-zero hash, no record, "No launch rules".
    expect(o.rules.hash).toBe("0".repeat(64));
    expect(o.rules.address).toBeNull();
    expect(o.rules.bytes).toHaveLength(0);
    expect(o.rules.explanation).toEqual([expect.stringMatching(/^No launch rules/)]);
    expect(r.rulesRecord).toBeNull();
    expect(r.attestation?.attested).toBe(true);
  });

  it("accepts each of the vector's deterministic signatures when the attestation records its leaf", () => {
    for (const s of LMS.signatures) {
      const i = inputs();
      const data = attestationData();
      new DataView(data.buffer).setUint16(74, s.q, true); // leaf 74..76
      data.set(fromHex(s.signature), 200); // signature 200..2708 (attestation v3)
      i.attestation = raw(i.attestation!.address, data);
      i.identity = raw(i.identity!.address, identityBytes([s.q]));
      i.certificate.pqLeaf = s.q;
      const r = checkPqOrigin(i);
      expect(r.problems, `q = ${s.q}`).toEqual([]);
      expect(r.origin?.leaf).toBe(s.q);
    }
  });

  it("the launch window is inclusive at both ends", () => {
    for (const at of [A.notBefore, A.notAfter]) {
      const i = inputs();
      i.certificate.launchedAt = BigInt(at);
      expect(checkPqOrigin(i).problems).toEqual([]);
    }
  });
});

describe("checkPqOrigin: not PQ-attested", () => {
  it("no attestation, a lamports-only address, another owner, undecodable data", () => {
    let i = inputs();
    i.attestation = null;
    expect(checkPqOrigin(i).origin).toBeNull();
    expect(problemsOf(i)).toMatch(/no attestation account .*not PQ-attested/);
    i = inputs();
    i.attestation = raw(i.attestation!.address, new Uint8Array(0), KNOWN_ACCOUNTS.system);
    expect(problemsOf(i)).toMatch(/no attestation account/);
    i = inputs();
    i.attestation = raw(i.attestation!.address, attestationData(), key("impostor-program"));
    expect(problemsOf(i)).toMatch(/owned by .*not PQ-attested/);
    i = inputs();
    i.attestation = raw(i.attestation!.address, attestationData().subarray(0, 100));
    expect(problemsOf(i)).toMatch(/cannot be decoded/);
  });

  it("a burn-only (empty) attestation, as the launchpad leaves it, is not an origin", () => {
    const i = inputs();
    i.attestation = raw(i.attestation!.address, fromHex(LMS.burnOnly.emptyAttestation));
    const r = checkPqOrigin(i);
    expect(r.origin).toBeNull();
    expect(r.record).toBeNull();
    expect(r.problems.join()).toMatch(/is empty \(version 0\).*not PQ-attested/);
  });

  it("an attestation of version 1 or 2 (messages v1, v2: retired, the launchpad signs v3) is not an origin", () => {
    for (const version of [1, 2]) {
      const i = inputs();
      const data = attestationData();
      data[8] = version;
      i.attestation = raw(i.attestation!.address, data);
      const r = checkPqOrigin(i);
      expect(r.origin).toBeNull();
      expect(r.problems.join()).toMatch(new RegExp(`has version ${version}, which the launchpad no longer accepts.*not PQ-attested`));
    }
  });

  it("the certificate's rules hash must be the attested one (all zero here)", () => {
    const i = inputs();
    i.certificate.rulesHash = new Uint8Array(32).fill(4);
    expect(problemsOf(i)).toMatch(/the certificate records launch rules, but the identity signed none/);
  });

  it("certificate and launch fields must be the attestation's", () => {
    let i = inputs();
    i.certificate.pqIdentity = new Uint8Array(32).fill(7);
    expect(problemsOf(i)).toMatch(/not the launch's pq_identity/);
    i = inputs();
    i.certificate.pqIdentity = new Uint8Array(32);
    expect(problemsOf(i)).toMatch(/no identity is named for this launch/);
    i = inputs();
    i.launch.pqIdentity = new Uint8Array(32).fill(7);
    expect(problemsOf(i)).toMatch(/not the launch's pq_identity/);
    i = inputs();
    i.certificate.pqLeaf = 510;
    expect(problemsOf(i)).toMatch(/certificate records leaf 510, the attestation leaf 511/);
    i = inputs();
    i.certificate.attestedSlot += 1n;
    expect(problemsOf(i)).toMatch(/attestation slot 400000001/);
    i = inputs();
    i.launch = null as unknown as LaunchAccount;
    expect(problemsOf(i)).toMatch(/Launch account is unreadable/);
    i = inputs();
    i.certificate.metadata = key("another record");
    expect(problemsOf(i)).toMatch(/certificate names the metadata record .*, not the attested GfoSG/);
  });

  it("the message is rebuilt from on-chain data: another creator or params_hash does not verify", () => {
    let i = inputs();
    i.launch.creator = key("other-creator");
    const p = problemsOf(i);
    expect(p).toMatch(/message hash is not the hash of the message rebuilt/);
    expect(p).toMatch(/signature does not verify at leaf 511/);
    i = inputs();
    i.launch.paramsHash = new Uint8Array(32).fill(1);
    expect(problemsOf(i)).toMatch(/signature does not verify/);
  });

  it("the metadata record: present, the launchpad's, at the signed hash's address, its content hashing to it", () => {
    let i = inputs();
    i.tokenMeta = null;
    expect(problemsOf(i)).toMatch(/no metadata record at GfoSG.*the attested metadata cannot be read/);
    i = inputs();
    i.tokenMeta = raw(recordKey, recordData(), key("impostor-program"));
    expect(problemsOf(i)).toMatch(/metadata record GfoSG.* is not owned by the launchpad/);
    i = inputs();
    i.tokenMeta = raw(key("elsewhere"), recordData());
    expect(problemsOf(i)).toMatch(/metadata record read is not the attested one/);
    i = inputs();
    const data = recordData();
    data[data.length - 2]! ^= 1; // inside the document
    i.tokenMeta = raw(recordKey, data);
    expect(problemsOf(i)).toMatch(/metadata record is invalid .*not the hash of its content/);
  });

  it("the mint must hold exactly the record's name, symbol and derived uri, and nothing more", () => {
    let i = inputs();
    i.metadata = { ...mintMetadata(), name: utf8("Noised Vector Tokem") };
    expect(problemsOf(i)).toMatch(/mint's name or symbol is not the attested record's/);
    i = inputs();
    i.metadata = { ...mintMetadata(), symbol: utf8("PHXW") };
    expect(problemsOf(i)).toMatch(/mint's name or symbol is not the attested record's/);
    i = inputs();
    i.metadata = { ...mintMetadata(), uri: utf8("https://example.org/x.json") };
    expect(problemsOf(i)).toMatch(/mint's uri is not the one derived from the attested record/);
    i = inputs();
    i.metadata = { ...mintMetadata(), additional: concatBytes([u32le(1), u32le(1), utf8("k"), u32le(1), utf8("v")]) };
    expect(problemsOf(i)).toMatch(/additional metadata the record does not/);
    i = inputs();
    i.metadata = null;
    expect(problemsOf(i)).toMatch(/mint's metadata is unreadable/);
  });

  it("a tampered signature, message hash or leaf", () => {
    let i = inputs();
    let data = attestationData();
    data[200 + 1_000]! ^= 1; // inside y
    i.attestation = raw(i.attestation!.address, data);
    let r = checkPqOrigin(i);
    expect(r.origin?.signatureValid).toBe(false);
    expect(r.problems.join()).toMatch(/signature does not verify/);
    i = inputs();
    data = attestationData();
    data[140]! ^= 1; // message_hash 140..172
    i.attestation = raw(i.attestation!.address, data);
    expect(problemsOf(i)).toMatch(/stored message hash/);
    // The attestation (and certificate) claim leaf 510 for a signature made at 511.
    i = inputs();
    data = attestationData();
    new DataView(data.buffer).setUint16(74, 510, true);
    i.attestation = raw(i.attestation!.address, data);
    i.identity = raw(i.identity!.address, identityBytes([510, 511]));
    i.certificate.pqLeaf = 510;
    r = checkPqOrigin(i);
    expect(r.origin?.signatureValid).toBe(false);
    expect(r.problems.join()).toMatch(/does not verify at leaf 510/);
  });

  it("the identity account: present, the launchpad's, the attested key, its leaf marked used", () => {
    let i = inputs();
    i.identity = null;
    expect(problemsOf(i)).toMatch(/no identity account/);
    i = inputs();
    i.identity = raw(i.identity!.address, identityData(), key("impostor-program"));
    expect(problemsOf(i)).toMatch(/not owned by the launchpad/);
    i = inputs();
    i.identity = raw(i.identity!.address, identityBytes([]));
    expect(problemsOf(i)).toMatch(/does not mark leaf 511 as used/);
    i = inputs();
    i.identity = raw(key("elsewhere"), identityData());
    expect(problemsOf(i)).toMatch(/not the attested identity's/);
    i = inputs();
    const bad = identityData();
    bad[194] = 9; // used_count disagrees with the bitmap
    i.identity = raw(i.identity!.address, bad);
    expect(problemsOf(i)).toMatch(/identity account is invalid/);
  });

  it("the launch must have run inside a window of 60..=3,600 s", () => {
    let i = inputs();
    i.certificate.launchedAt = BigInt(A.notAfter) + 1n;
    expect(problemsOf(i)).toMatch(/outside the attested window/);
    i = inputs();
    i.certificate.launchedAt = BigInt(A.notBefore) - 1n;
    expect(problemsOf(i)).toMatch(/outside the attested window/);
    i = inputs();
    const data = attestationData();
    new DataView(data.buffer).setBigInt64(188, BigInt(A.notBefore) + 3_601n, true); // not_after 188..196
    i.attestation = raw(i.attestation!.address, data);
    expect(problemsOf(i)).toMatch(/window lasts 3601 s/);
  });
});

describe("verifyAttestation (before launch, from live accounts)", () => {
  /** The vector launch, its record, identity and attestation, as the launchpad leaves them. */
  function chain(): MockConnection {
    const conn = new MockConnection();
    conn.set(launchKey, { owner: PROGRAM_IDS.launchpad, data: fromHex(LMS.accounts.launch.data) });
    conn.set(attestationAddress(launchKey), { owner: PROGRAM_IDS.launchpad, data: attestationData() });
    conn.set(identityAddressFromId(identityId), { owner: PROGRAM_IDS.launchpad, data: identityData() });
    conn.set(recordKey, { owner: PROGRAM_IDS.launchpad, data: recordData() });
    return conn;
  }

  it("verified: the identity the launch names signed it, the record it signed exists and hashes to the signed hash", async () => {
    const r = await verifyAttestation(chain().asConnection(), launchKey);
    expect(r.problems).toEqual([]);
    expect(r.verified).toBe(true);
    expect(r.origin?.verified).toBe(true);
    expect(r.origin?.leaf).toBe(511);
    expect(r.tokenMeta?.publicKey.toBase58()).toBe(LMS.metadata.tokenMetaAccount);
    expect(r.tokenMeta?.symbol).toBe(LMS.metadata.symbol);
    expect(r.launch?.status).toBe("configured");
    expect(r.launchRules).toBeNull();
    expect(r.origin?.rules.explanation).toEqual([expect.stringMatching(/^No launch rules/)]);
  });

  it("not verified: no attestation, an empty one, a missing record, a launch naming another identity, no launch", async () => {
    let conn = chain();
    conn.delete(attestationAddress(launchKey));
    let r = await verifyAttestation(conn.asConnection(), launchKey);
    expect([r.verified, r.origin, r.tokenMeta]).toEqual([false, null, null]);
    expect(r.problems.join()).toMatch(/no attestation account/);
    conn = chain();
    conn.set(attestationAddress(launchKey), { owner: PROGRAM_IDS.launchpad, data: fromHex(LMS.burnOnly.emptyAttestation) });
    r = await verifyAttestation(conn.asConnection(), launchKey);
    expect(r.verified).toBe(false);
    expect(r.problems.join()).toMatch(/is empty \(version 0\)/);
    conn = chain();
    conn.delete(recordKey);
    r = await verifyAttestation(conn.asConnection(), launchKey);
    expect([r.verified, r.origin?.verified, r.tokenMeta]).toEqual([false, false, null]);
    expect(r.problems.join()).toMatch(/no metadata record at/);
    conn = chain();
    const other = fromHex(LMS.accounts.launch.data);
    other.set(new Uint8Array(32).fill(9), 553); // pq_identity
    conn.set(launchKey, { owner: PROGRAM_IDS.launchpad, data: other });
    r = await verifyAttestation(conn.asConnection(), launchKey);
    expect(r.verified).toBe(false);
    expect(r.problems.join()).toMatch(/not the launch's pq_identity/);
    conn = chain();
    conn.delete(launchKey);
    r = await verifyAttestation(conn.asConnection(), launchKey);
    expect(r.verified).toBe(false);
    expect(r.problems.join()).toMatch(/no launchpad-owned Launch account/);
    await expect(verifyAttestation(conn.asConnection(), "x" as unknown as PublicKey)).rejects.toThrow(/PublicKey/);
  });
});

describe("tokenMetadataFields", () => {
  it("returns the stored bytes exactly (a leading BOM included) and the additional-metadata bytes", () => {
    const mint = key("meta/mint");
    const spec = ext.tokenMetadata({ updateAuthority: null, mint, name: "﻿Name", symbol: "S€", uri: "" });
    const f = tokenMetadataFields(spec.data);
    expect(toHex(f.name)).toBe(toHex(utf8("﻿Name")));
    expect(f.name.length).toBe(7);
    expect(toHex(f.symbol)).toBe(toHex(utf8("S€")));
    expect(f.uri.length).toBe(0);
    expect(toHex(f.additional)).toBe("00000000");
    expect(() => tokenMetadataFields(spec.data.subarray(0, 70))).toThrow(/truncated/);
    expect(() => tokenMetadataFields(concatBytes([new Uint8Array(64), u32le(5), utf8("abc")]))).toThrow(/name is truncated/);
  });
});

/**
 * LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4 (`src/pq/lms.ts`) byte for byte
 * against the Rust crate the launchpad verifies with:
 *
 * - RFC 8554 Appendix F (`vectors/rfc8554_appendix_f.json`, a copy of
 *   `crates/noised-lmots/tests/rfc8554_appendix_f.json`): Test Case 2's
 *   top-level tree is this parameter set (key generation from its SEED and
 *   I, the published signature, signing with its C, the auth path); the
 *   H5/W8 levels must be refused, as `noised_lmots` refuses them;
 * - `vectors/lms.json` (a copy of `tests/integration/vectors/lms.json`,
 *   written by `tests/integration/tests/lms_vectors.rs` from
 *   `noised-lmots`): the identity's public key, all 2,047 tree nodes
 *   (`nodesSha256`), the five deterministic signatures, the 20 rejections;
 * - the known answers of `crates/noised-lmots/tests/lms.rs` (from an
 *   independent Python implementation of RFC 8554).
 */
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { PQ_IDENTITY } from "../src/constants.js";
import { metadataHashV2 } from "../src/metadata/record.js";
import { attestationMessage } from "../src/pq/identity.js";
import * as lmots from "../src/pq/lmots.js";
import {
  D_INTR,
  D_LEAF,
  encodeLmsPublicKey,
  identityId,
  LMS_HEIGHT,
  LMS_LEAVES,
  LMS_OTS_TYPE,
  LMS_PUBLIC_KEY_LEN,
  LMS_SIGNATURE_LEN,
  LMS_SIGNATURE_OFFSETS,
  LMS_TREE_NODES,
  LMS_TYPE,
  lmsKeygen,
  lmsKeygenSync,
  lmsKeyPair,
  lmsKeyPairFromTreeCache,
  lmsVerify,
  memoryTreeCacheStore,
  parseLmsPublicKey,
  parseLmsSignature,
  signLeafDeterministic,
  signLeafWithRandomizer,
  TREE_CACHE_LEN,
  TREE_CACHE_TAG,
  treeCacheKey,
  type LmsKeyPair,
  type LmsPrivateKey,
} from "../src/pq/lms.js";
import * as lmsModule from "../src/pq/lms.js";
import * as sdk from "../src/index.js";

interface Patch {
  op: "set" | "xor" | "truncate" | "append";
  offset?: number;
  hex?: string;
  length?: number;
}
interface LmsVectors {
  parameters: { lmsType: number; otsType: number; height: number; leaves: number; publicKeyLen: number; signatureLen: number; identityIdDomain: number };
  identity: { seed: string; i: string; root: string; publicKey: string; identityId: string; nodesSha256: string };
  attestation: { message: string; launchBytes: string; paramsHash: string; creatorBytes: string; notBefore: number; notAfter: number };
  signatures: { q: number; c: string; signature: string; sha256: string }[];
  rejections: { name: string; signaturePatch: Patch[]; publicKeyPatch: Patch[]; metadata: { nameHex: string; symbolHex: string; flags: number; uriHex: string; docHex: string }; verify: null }[];
  attestLaunch: { q: number };
}

const V = JSON.parse(readFileSync(new URL("./vectors/lms.json", import.meta.url), "utf8")) as LmsVectors;
const RFC = JSON.parse(readFileSync(new URL("./vectors/rfc8554_appendix_f.json", import.meta.url), "utf8")) as Record<
  "test_case_1" | "test_case_2",
  { hss_public_key: string; message: string; hss_signature: string; top_level_seed?: string; top_level_i?: string }
>;

const be32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, false);

/** Apply a vector patch (`tests/integration/tests/common/launchpad.rs::apply_patch`). */
function applyPatch(bytes: Uint8Array, ops: Patch[]): Uint8Array {
  let out: Uint8Array = Uint8Array.from(bytes);
  for (const op of ops) {
    if (op.op === "set") out.set(fromHex(op.hex!), op.offset!);
    else if (op.op === "xor") fromHex(op.hex!).forEach((b, i) => (out[op.offset! + i]! ^= b));
    else if (op.op === "truncate") out = out.slice(0, op.length!);
    else out = concatBytes([out, fromHex(op.hex!)]);
  }
  return out;
}

/** RFC 8554 Test Case 2, top-level tree (the HSS public key without L, and sig[0] at q = 3 over the child's key). */
const tc2 = (() => {
  const tc = RFC.test_case_2;
  const hssPk = fromHex(tc.hss_public_key);
  const hssSig = fromHex(tc.hss_signature);
  expect(be32(hssPk, 0)).toBe(2);
  expect(be32(hssSig, 0)).toBe(1);
  return {
    sk: { seed: fromHex(tc.top_level_seed!), id: fromHex(tc.top_level_i!) } satisfies LmsPrivateKey,
    pk: hssPk.slice(4),
    childPk: hssSig.slice(4 + LMS_SIGNATURE_LEN, 4 + LMS_SIGNATURE_LEN + 56),
    sig: hssSig.slice(4, 4 + LMS_SIGNATURE_LEN),
  };
})();

/** The H5/W8 levels of Appendix F (LMS_SHA256_M32_H5 over LMOTS_SHA256_N32_W8): 1,292-byte signatures. */
function h5w8Levels(): { pk: Uint8Array; msg: Uint8Array; sig: Uint8Array }[] {
  const H5W8_SIG = 4 + 4 + 32 + 34 * 32 + 4 + 5 * 32;
  const out: { pk: Uint8Array; msg: Uint8Array; sig: Uint8Array }[] = [];
  for (const name of ["test_case_1", "test_case_2"] as const) {
    const tc = RFC[name];
    const pk = fromHex(tc.hss_public_key).slice(4);
    const sig = fromHex(tc.hss_signature);
    const len0 = name === "test_case_1" ? H5W8_SIG : LMS_SIGNATURE_LEN;
    const pub1 = sig.slice(4 + len0, 4 + len0 + 56);
    const sig1 = sig.slice(4 + len0 + 56);
    expect(sig1.length).toBe(H5W8_SIG);
    if (name === "test_case_1") out.push({ pk, msg: pub1, sig: sig.slice(4, 4 + len0) });
    out.push({ pk: pub1, msg: fromHex(tc.message), sig: sig1 });
  }
  return out;
}

/** `crates/noised-lmots/tests/lms.rs::attestation_shaped`: "PHX-ATTEST-V1" and five 32-byte fields tag+1..tag+5. */
function attestationShaped(tag: number): Uint8Array {
  return concatBytes([utf8("PHX-ATTEST-V1"), ...[1, 2, 3, 4, 5].map((f) => new Uint8Array(32).fill((tag + f) & 0xff))]);
}

const identitySk: LmsPrivateKey = { seed: fromHex(V.identity.seed), id: fromHex(V.identity.i) };
const message = fromHex(V.attestation.message);
let tc2Kp: LmsKeyPair;
let kp: LmsKeyPair;
let syncMs = 0;

beforeAll(() => {
  tc2Kp = lmsKeygenSync(tc2.sk);
  const t0 = performance.now();
  kp = lmsKeygenSync(identitySk);
  syncMs = performance.now() - t0;
});

describe("LMS parameters and layout", () => {
  it("match the crate and the vectors", () => {
    const p = V.parameters;
    expect([LMS_TYPE, LMS_OTS_TYPE, LMS_HEIGHT, LMS_LEAVES, LMS_PUBLIC_KEY_LEN, LMS_SIGNATURE_LEN]).toEqual([p.lmsType, p.otsType, p.height, p.leaves, p.publicKeyLen, p.signatureLen]);
    expect(LMS_SIGNATURE_OFFSETS).toEqual({ q: 0, otsType: 4, c: 8, y: 40, lmsType: 2184, path: 2188 });
    expect(LMS_TREE_NODES).toBe(2047);
    expect(TREE_CACHE_LEN).toBe(65_536);
    expect(p.identityIdDomain).toBe(0x21);
    // The constants the rest of the SDK reads agree with this module.
    expect(PQ_IDENTITY).toMatchObject({ LMS_TYPE, LMOTS_TYPE: LMS_OTS_TYPE, HEIGHT: LMS_HEIGHT, LEAVES: LMS_LEAVES, PUBLIC_KEY_LEN: LMS_PUBLIC_KEY_LEN, SIGNATURE_LEN: LMS_SIGNATURE_LEN, IDENTITY_ID_DOMAIN: 0x21 });
  });
});

describe("RFC 8554 Appendix F, Test Case 2 (top level: LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4)", () => {
  it("key generation from SEED and I reproduces the published public key", () => {
    expect(toHex(tc2Kp.publicKey)).toBe(toHex(tc2.pk));
    expect(parseLmsPublicKey(tc2.pk)).toEqual({ id: tc2.sk.id, root: tc2.pk.slice(24) });
    expect(toHex(encodeLmsPublicKey(parseLmsPublicKey(tc2.pk)!))).toBe(toHex(tc2.pk));
    // Leaf 3's node is the LM-OTS key that signed the RFC's message (the fast key generation agrees with lmots.ts).
    const k3 = lmots.publicKey({ id: tc2.sk.id, q: 3, seed: tc2.sk.seed }).k;
    expect(toHex(tc2Kp.node(1024 + 3))).toBe(toHex(sha256(concatBytes([tc2.sk.id, Uint8Array.of(0, 0, 4, 3), D_LEAF, k3]))));
  });

  it("the published signature verifies at leaf 3 and parses as the RFC lays it out", () => {
    expect(lmsVerify(tc2.pk, tc2.childPk, tc2.sig)).toBe(3);
    const parsed = parseLmsSignature(tc2.sig)!;
    expect(parsed.q).toBe(3);
    expect(toHex(parsed.otsSignature)).toBe(toHex(tc2.sig.subarray(8, 2184)));
    expect(toHex(parsed.path)).toBe(toHex(tc2.sig.subarray(2188)));
    // Assembled from the per-field file of the LM-OTS tests.
    const f = JSON.parse(readFileSync(new URL("./vectors/rfc8554_tc2.json", import.meta.url), "utf8")) as { c: string; y: string[]; path: string[]; message: string; root: string };
    const assembled = concatBytes([Uint8Array.of(0, 0, 0, 3, 0, 0, 0, 3), fromHex(f.c), ...f.y.map(fromHex), Uint8Array.of(0, 0, 0, 6), ...f.path.map(fromHex)]);
    expect(toHex(assembled)).toBe(toHex(tc2.sig));
    expect(f.message).toBe(toHex(tc2.childPk));
    expect(f.root).toBe(toHex(tc2.pk.slice(24)));
  });

  it("signing with the published C reproduces the published signature, and the auth path is Appendix D's", () => {
    expect(toHex(signLeafWithRandomizer(tc2Kp, 3, tc2.childPk, tc2.sig.slice(8, 40)))).toBe(toHex(tc2.sig));
    expect(toHex(tc2Kp.authPath(3))).toBe(toHex(tc2.sig.subarray(2188)));
  });

  it("identityId known answers (crates/noised-lmots/tests/lms.rs)", () => {
    expect(toHex(identityId(tc2.pk))).toBe("7846a2ebb04cd38e8bee0143e1ee67e7858bcf99e97e73be905d0385620f9171");
    expect(toHex(tc2Kp.identityId)).toBe("7846a2ebb04cd38e8bee0143e1ee67e7858bcf99e97e73be905d0385620f9171");
    expect(() => identityId(tc2.pk.subarray(1))).toThrow(/56 bytes/);
  });

  it("the strict parsers refuse every H5/W8 level (Test Case 1, Test Case 2's second level)", () => {
    const levels = h5w8Levels();
    expect(levels.length).toBe(3);
    for (const l of levels) {
      expect(toHex(l.pk.subarray(0, 8))).toBe("0000000500000004");
      expect(parseLmsPublicKey(l.pk)).toBeNull();
      expect(parseLmsSignature(l.sig)).toBeNull();
      expect(lmsVerify(l.pk, l.msg, l.sig)).toBeNull();
    }
  });
});

describe("the vector identity (tests/integration/vectors/lms.json)", () => {
  it("key generation reproduces the public key, the root, the identity id and all 2,047 nodes", () => {
    expect(toHex(kp.publicKey)).toBe(V.identity.publicKey);
    expect(toHex(kp.root)).toBe(V.identity.root);
    expect(toHex(kp.id)).toBe(V.identity.i);
    expect(toHex(kp.identityId)).toBe(V.identity.identityId);
    expect(toHex(identityId(kp.publicKey))).toBe(V.identity.identityId);
    expect(kp.nodes().length).toBe(LMS_TREE_NODES * 32);
    expect(toHex(sha256(kp.nodes()))).toBe(V.identity.nodesSha256);
    // Every interior node is the hash of its children (RFC 8554 section 5.3).
    for (const r of [1, 2, 511, 1023]) {
      expect(toHex(kp.node(r))).toBe(toHex(sha256(concatBytes([kp.id, Uint8Array.of(0, 0, r >> 8, r & 0xff), D_INTR, kp.node(2 * r), kp.node(2 * r + 1)]))));
    }
  });

  it("the fast leaf hashes equal lmots.publicKey leaf by leaf", () => {
    for (const q of [0, 1, 2, 511, 512, 777, 1023]) {
      const k = lmots.publicKey({ id: identitySk.id, q, seed: identitySk.seed }).k;
      const r = 1024 + q;
      expect(toHex(kp.node(r)), `leaf ${q}`).toBe(toHex(sha256(concatBytes([identitySk.id, Uint8Array.of(0, 0, r >> 8, r & 0xff), D_LEAF, k]))));
    }
  });

  it("deterministic signatures at leaves 0, 1, 511, 512, 1023 are the Rust bytes", () => {
    expect(V.signatures.map((s) => s.q)).toEqual([0, 1, 511, 512, 1023]);
    for (const s of V.signatures) {
      const sig = signLeafDeterministic(kp, s.q, message);
      expect(toHex(sig), `leaf ${s.q}`).toBe(s.signature);
      expect(toHex(sha256(sig))).toBe(s.sha256);
      expect(toHex(kp.randomizer(s.q, message))).toBe(s.c);
      expect(toHex(sig.subarray(8, 40))).toBe(s.c);
      expect(lmsVerify(kp.publicKey, message, sig)).toBe(s.q);
      expect(toHex(kp.authPath(s.q))).toBe(toHex(sig.subarray(2188)));
      // Retrying reproduces the identical bytes.
      expect(toHex(signLeafDeterministic(kp, s.q, message))).toBe(s.signature);
    }
  });

  it("every rejection of the vectors fails verification (patched signatures, keys and messages)", () => {
    const base = fromHex(V.signatures.find((s) => s.q === V.attestLaunch.q)!.signature);
    const pk = kp.publicKey;
    expect(lmsVerify(pk, message, base)).toBe(511);
    const a = V.attestation;
    expect(V.rejections.length).toBe(20);
    for (const r of V.rejections) {
      const m = r.metadata;
      const msg = attestationMessage({
        launch: new PublicKey(fromHex(a.launchBytes)),
        paramsHash: fromHex(a.paramsHash),
        creator: new PublicKey(fromHex(a.creatorBytes)),
        metadataHash: metadataHashV2({ name: fromHex(m.nameHex), symbol: fromHex(m.symbolHex), flags: m.flags, uri: fromHex(m.uriHex), doc: fromHex(m.docHex) }),
        notBefore: BigInt(a.notBefore),
        notAfter: BigInt(a.notAfter),
      });
      const badPk = applyPatch(pk, r.publicKeyPatch);
      const badSig = applyPatch(base, r.signaturePatch);
      expect(r.signaturePatch.length + r.publicKeyPatch.length > 0 || toHex(msg) !== V.attestation.message, r.name).toBe(true);
      expect(lmsVerify(badPk, msg, badSig), r.name).toBeNull();
    }
  });
});

describe("known answers of crates/noised-lmots/tests/lms.rs (independent Python reference)", () => {
  it("signatures of 173-byte attestation-shaped messages by localnet identity 0", () => {
    const msg = attestationShaped(0);
    expect(msg.length).toBe(173);
    const expected: [number, string, string][] = [
      [0, "6cb6a8d4ae48eaf78a9bcbe3dacf9150bedc46118767dae4509fe0ef8f8cb4dc", "699d3b3b95b40e970cd548013337d62004d8716a51db5b2268c0577fe504bc33"],
      [1, "8da99370f25644aeed103ea24426ec74b850da2e9f3baecf2daa74ea7f9e5754", "b8b7648e645c4c84ff927bf3d644ec759e62e2137abd5d3c76d5b2ddb1461483"],
      [511, "51229f470e21560837219007506f17ed61f5b167d4148ccb51c28fa00fbd2025", "439363efae0d922335dc9de8b81701ce97ec962352b8c2480e38a830d03a685c"],
      [512, "141531f1f8b001f0e13e30b78ef904411234df9752586bb9f4261e217a346373", "acfbac081bca9f84f86f8ae1d0a3efc745e2a83b8e540fbb09b33169b2e3bee8"],
      [1023, "a4bb1e6d3ee4b0eec3e99f41dee842fa4d0e0343c8f6657907a610c8522cfe08", "aa899bb6755383927c115bdc25a2ea9a8e842251fb73b5dee6affc6ba7623f7a"],
    ];
    for (const [q, c, sigHash] of expected) {
      const sig = signLeafDeterministic(kp, q, msg);
      expect(toHex(sig.subarray(8, 40)), `C at leaf ${q}`).toBe(c);
      expect(toHex(sha256(sig)), `signature at leaf ${q}`).toBe(sigHash);
      expect(lmsVerify(kp.publicKey, msg, sig)).toBe(q);
      // Another identity's key does not accept it.
      expect(lmsVerify(tc2.pk, msg, sig)).toBeNull();
    }
    expect(lmsVerify(kp.publicKey, tc2.childPk, tc2.sig)).toBeNull();
  });
});

describe("tampering and malformed input", () => {
  const sig = () => fromHex(V.signatures[2]!.signature); // leaf 511
  const put32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset).setUint32(at, v, false);

  it("the leaf index is bound: another q, q >= 1024 and q = 2^32 - 1 fail", () => {
    for (const q of [510, 512, 0, 1023, 1024, 0xffffffff]) {
      const s = sig();
      put32(s, 0, q);
      expect(lmsVerify(kp.publicKey, message, s), `q = ${q}`).toBeNull();
      // The strict parser refuses a leaf the tree does not have.
      expect(parseLmsSignature(s) === null, `q = ${q}`).toBe(q >= 1024);
    }
  });

  it("every typecode is checked, in the signature and in the key", () => {
    for (const [at, v] of [[4, 4], [4, 1], [2184, 5], [2184, 7]] as const) {
      const s = sig();
      put32(s, at, v);
      expect(lmsVerify(kp.publicKey, message, s)).toBeNull();
      expect(parseLmsSignature(s)).toBeNull();
    }
    for (const [at, v] of [[0, 5], [4, 4]] as const) {
      const pk = kp.publicKey;
      put32(pk, at, v);
      expect(parseLmsPublicKey(pk)).toBeNull();
      expect(lmsVerify(pk, message, sig())).toBeNull();
    }
  });

  it("every part of the signature, the key and the message is bound", () => {
    for (const at of [8, 39, 40, 1000, 2183, 2188, 2219, 2220, 2507]) {
      const s = sig();
      s[at]! ^= 0x01;
      expect(lmsVerify(kp.publicKey, message, s), `byte ${at}`).toBeNull();
    }
    for (const at of [8, 23, 24, 55]) {
      const pk = kp.publicKey;
      pk[at]! ^= 0x80;
      expect(lmsVerify(pk, message, sig()), `key byte ${at}`).toBeNull();
    }
    const m = Uint8Array.from(message);
    expect(m).toHaveLength(221);
    m[220]! ^= 1;
    expect(lmsVerify(kp.publicKey, m, sig())).toBeNull();
    expect(lmsVerify(kp.publicKey, message.subarray(1), sig())).toBeNull();
  });

  it("wrong lengths are refused", () => {
    const s = sig();
    for (const bad of [s.subarray(1), concatBytes([s, Uint8Array.of(0)]), new Uint8Array(0)]) expect(lmsVerify(kp.publicKey, message, bad)).toBeNull();
    for (const bad of [kp.publicKey.subarray(1), concatBytes([kp.publicKey, Uint8Array.of(0)])]) expect(lmsVerify(bad, message, s)).toBeNull();
  });

  it("the signer refuses leaves outside the tree and bad randomizers", () => {
    for (const q of [-1, 1024, 1.5, Number.NaN]) {
      expect(() => signLeafDeterministic(kp, q, message)).toThrow(/leaf/);
      expect(() => kp.authPath(q)).toThrow(/leaf/);
    }
    expect(() => signLeafWithRandomizer(kp, 5, message, new Uint8Array(31))).toThrow(/32 bytes/);
    // Two randomizers give two valid signatures at one leaf: exactly what must never happen (which is why
    // this signer is internal to the SDK, for the RFC known answers only).
    const a = signLeafWithRandomizer(kp, 77, message, new Uint8Array(32).fill(1));
    const b = signLeafWithRandomizer(kp, 77, message, new Uint8Array(32).fill(2));
    expect(toHex(a)).not.toBe(toHex(b));
    expect([lmsVerify(kp.publicKey, message, a), lmsVerify(kp.publicKey, message, b)]).toEqual([77, 77]);
  });

  it("no public signing path around the leaf ledger (review finding): LmsKeyPair has no sign method, the package's lms namespace exports no signer", () => {
    // A production key pair (every PqIdentity carries one) cannot sign at a caller-chosen leaf or randomizer.
    for (const m of ["sign", "signDeterministic", "signAt", "signLeaf"]) {
      expect(m in kp, m).toBe(false);
      expect(m in lmsModule.LmsKeyPair.prototype, m).toBe(false);
    }
    expect(Object.getOwnPropertyNames(lmsModule.LmsKeyPair.prototype).filter((n) => /sign/i.test(n))).toEqual([]);
    expect(Object.getOwnPropertySymbols(lmsModule.LmsKeyPair.prototype)).toEqual([]);
    // The package root's `lms` is this module minus its two internal signers (and the secret probe key's derivation,
    // audit 4 ID-F1a: a key pair computes its own probe), nothing else.
    const internal = ["signLeafDeterministic", "signLeafWithRandomizer", "leafProbeKey"];
    expect(Object.keys(sdk.lms).sort()).toEqual(Object.keys(lmsModule).filter((k) => !internal.includes(k)).sort());
    for (const k of internal) expect(k in sdk.lms, k).toBe(false);
    // The only exported LMS signers left are the ledger's (pendingSignatures and launchSignatures only list records).
    expect(Object.keys(sdk.leafLedger).filter((k) => /sign/i.test(k)).sort()).toEqual(["launchSignatures", "pendingSignatures", "reserveAndSign", "signAtNextLeaf"]);
    expect(Object.keys(sdk.pqIdentity).filter((k) => /^sign/i.test(k))).toEqual([]);
  });

  it("refuses an all-zero or misshapen SEED and I", () => {
    expect(() => lmsKeygenSync({ seed: new Uint8Array(32), id: identitySk.id })).toThrow(/all-zero/);
    expect(() => lmsKeygenSync({ seed: identitySk.seed.subarray(1), id: identitySk.id })).toThrow(/32 bytes/);
    expect(() => lmsKeygenSync({ seed: identitySk.seed, id: new Uint8Array(15) })).toThrow(/16 bytes/);
  });
});

describe("tree cache", () => {
  it("round-trips: the cached key pair has the same key and signs the same bytes", () => {
    const blob = kp.exportTreeCache();
    expect(blob.length).toBe(TREE_CACHE_LEN);
    expect(toHex(blob.subarray(0, LMS_TREE_NODES * 32))).toBe(toHex(kp.nodes()));
    expect(toHex(blob.subarray(LMS_TREE_NODES * 32))).toBe(toHex(lmots.hmacSha256(identitySk.seed, [TREE_CACHE_TAG, identitySk.id, kp.nodes()])));
    const cached = lmsKeyPairFromTreeCache(identitySk, blob, { expectedPublicKey: fromHex(V.identity.publicKey) });
    expect(toHex(cached.publicKey)).toBe(V.identity.publicKey);
    expect(toHex(signLeafDeterministic(cached, 511, message))).toBe(V.signatures[2]!.signature);
  });

  it("refuses tampered caches, other keys' caches and an unexpected public key", () => {
    const blob = kp.exportTreeCache();
    for (const at of [0, 32 * 1023, 32 * 2046 + 5, TREE_CACHE_LEN - 1]) {
      const bad = Uint8Array.from(blob);
      bad[at]! ^= 1;
      expect(() => lmsKeyPairFromTreeCache(identitySk, bad), `byte ${at}`).toThrow(/tag does not match/);
    }
    expect(() => lmsKeyPairFromTreeCache(tc2.sk, blob)).toThrow(/tag does not match/);
    expect(() => lmsKeyPairFromTreeCache(identitySk, blob.subarray(1))).toThrow(/65536 bytes/);
    expect(() => lmsKeyPairFromTreeCache(identitySk, blob, { expectedPublicKey: tc2.pk })).toThrow(/not the expected one/);
  });

  it("a tagged but inconsistent tree is refused; a consistent tree of the wrong leaves signs nothing", () => {
    // Whoever holds SEED can tag anything: the interior check still refuses a tree whose nodes do not hash to their children.
    const tag = (nodes: Uint8Array) => concatBytes([nodes, lmots.hmacSha256(identitySk.seed, [TREE_CACHE_TAG, identitySk.id, nodes])]);
    const nodes = kp.nodes();
    nodes[100]! ^= 1;
    expect(() => lmsKeyPairFromTreeCache(identitySk, tag(nodes))).toThrow(/does not hash to its children/);
    // A consistent tree over other leaves: every signature fails self-verification and is withheld.
    const fake = new Uint8Array(LMS_TREE_NODES * 32);
    for (let q = 0; q < LMS_LEAVES; q++) fake.set(sha256(Uint8Array.of(q >> 8, q & 0xff)), (1023 + q) * 32);
    for (let r = 1023; r >= 1; r--) {
      fake.set(sha256(concatBytes([identitySk.id, Uint8Array.of(0, 0, r >> 8, r & 0xff), D_INTR, fake.subarray((2 * r - 1) * 32, (2 * r + 1) * 32)])), (r - 1) * 32);
    }
    const wrong = lmsKeyPairFromTreeCache(identitySk, tag(fake));
    expect(() => signLeafDeterministic(wrong, 5, message)).toThrow(/self-verification/);
  });

  it("lmsKeyPair generates once, then loads from the store; a rejected cache is regenerated", async () => {
    const store = memoryTreeCacheStore();
    const progress: number[] = [];
    const first = await lmsKeyPair(identitySk, { cache: store, onProgress: (d) => progress.push(d) });
    expect(toHex(first.publicKey)).toBe(V.identity.publicKey);
    expect(progress.length).toBeGreaterThan(1);
    expect(treeCacheKey(identitySk)).toBe(`noised/pq/lms-tree/v1/${V.identity.i}`);
    expect((await store.get(treeCacheKey(identitySk)))!.length).toBe(TREE_CACHE_LEN);

    const again: number[] = [];
    const rejected: unknown[] = [];
    const t0 = performance.now();
    const second = await lmsKeyPair(identitySk, { cache: store, onProgress: (d) => again.push(d), onCacheRejected: (e) => rejected.push(e) });
    const cachedMs = performance.now() - t0;
    expect(again).toEqual([LMS_LEAVES]);
    expect(rejected).toEqual([]);
    expect(toHex(signLeafDeterministic(second, 1, message))).toBe(V.signatures[1]!.signature);
    console.log(`LMS key pair from the tree cache: ${cachedMs.toFixed(1)} ms`);

    const bad = (await store.get(treeCacheKey(identitySk)))!;
    bad[7]! ^= 1;
    await store.put(treeCacheKey(identitySk), bad);
    const third = await lmsKeyPair(identitySk, { cache: store, onCacheRejected: (e) => rejected.push(e) });
    expect(rejected.length).toBe(1);
    expect(toHex(third.publicKey)).toBe(V.identity.publicKey);
    expect(toHex((await store.get(treeCacheKey(identitySk)))!)).toBe(toHex(third.exportTreeCache()));
    await expect(lmsKeyPair(identitySk, { cache: store, expectedPublicKey: tc2.pk })).rejects.toThrow(/not the expected one/);
  });
});

describe("non-blocking key generation", () => {
  it("works in slices, reports progress, yields, and builds the same tree as the synchronous one", async () => {
    let yields = 0;
    const progress: [number, number][] = [];
    const t0 = performance.now();
    const k = await lmsKeygen(identitySk, {
      sliceMs: 4,
      onProgress: (d, t) => progress.push([d, t]),
      yieldToEventLoop: () => {
        yields++;
        return new Promise((r) => setImmediate(r));
      },
    });
    const asyncMs = performance.now() - t0;
    expect(toHex(k.publicKey)).toBe(V.identity.publicKey);
    expect(toHex(k.nodes())).toBe(toHex(kp.nodes()));
    expect(progress.at(-1)).toEqual([1024, 1024]);
    expect(progress.every(([d, t], i) => t === 1024 && d > 0 && (i === 0 || d > progress[i - 1]![0]))).toBe(true);
    expect(yields).toBe(progress.length - 1);
    expect(yields).toBeGreaterThan(10);
    // A measurement, not an assertion: wall-clock time depends on the machine's load.
    console.log(`LMS H10 key generation (1,024 leaves, Node ${process.versions.node}): sync ${syncMs.toFixed(0)} ms, async ${asyncMs.toFixed(0)} ms in ${progress.length} slices`);
  });

  it("the default yield lets timers run during key generation", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const k = await lmsKeygen(identitySk, { sliceMs: 8 });
      expect(toHex(k.root)).toBe(V.identity.root);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(3);
  });

  it("aborts between slices", async () => {
    const ctl = new AbortController();
    const reason = new Error("user cancelled");
    let calls = 0;
    await expect(
      lmsKeygen(identitySk, {
        sliceMs: 1,
        signal: ctl.signal,
        onProgress: () => {
          if (++calls === 2) ctl.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    expect(calls).toBe(2);
  });

  it("wipe() destroys the signing secret", () => {
    const k = lmsKeyPairFromTreeCache(identitySk, kp.exportTreeCache());
    expect(k.wiped).toBe(false);
    k.wipe();
    expect(k.wiped).toBe(true);
    expect(() => signLeafDeterministic(k, 0, message)).toThrow(/wiped/);
    expect(() => k.exportTreeCache()).toThrow(/wiped/);
    // The public half stays usable.
    expect(toHex(k.publicKey)).toBe(V.identity.publicKey);
  });
});

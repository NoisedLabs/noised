/**
 * PQ creator identity (`src/pq/identity.ts`) byte for byte against
 * `vectors/lms.json` (a copy of `tests/integration/vectors/lms.json`, which
 * `tests/integration/tests/lms_vectors.rs` writes from `noised-lmots` and
 * the launchpad's documented layouts, and `vectors_onchain.rs` lands on the
 * launchpad build): the A12 derivation, the passkey HKDF, identity ids and
 * accounts, the bitmap and leaf probe, the 221-byte message v3, the
 * metadata record's hash, address and limits (UTF-8 bytes), the launch
 * window, the Identity and Attestation accounts, the events, and every
 * burn-only landing's signature.
 */
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { CLUSTERS, PQ_IDENTITY, PROGRAM_IDS, type Cluster } from "../src/constants.js";
import {
  ATTEST_MESSAGE_LEN,
  ATTEST_MESSAGE_TAG,
  attestationAttestsMessage,
  attestationMessage,
  checkPasskeyRpId,
  chooseLeaf,
  decodePqAttestEvent,
  deriveIdentity,
  deriveIdentityFromPhrase,
  deriveIdentityKey,
  deriveMasterFromPasskeyAssertion,
  deriveMasterFromPasskeyPrf,
  exportMasterAsPhrase,
  IDENTITY_ID_TAG,
  IDENTITY_SEED_TAG,
  identityId,
  identityPath,
  importMaster,
  LEAF_BITMAP_LEN,
  LEAF_PROBE_TAG,
  LEAF_WARN_AT_USED,
  leafProbeStart,
  leafUsed,
  markLeafUsed,
  MAX_IDENTITY_CLUSTER,
  MAX_LAUNCH_LEAD_SECS,
  MAX_LAUNCH_WINDOW_SECS,
  METADATA_HASH_TAG,
  MIN_LAUNCH_WINDOW_SECS,
  nextFreeLeaf,
  parseAttestationMessage,
  PASSKEY_HKDF_INFO,
  PASSKEY_HKDF_SALT,
  PASSKEY_PRF_SALT,
  passkeyCreationOptions,
  passkeyEntropy,
  passkeyPrfFromAssertion,
  passkeyPrfSalt,
  passkeyRequestOptions,
  usedLeafCount,
  usedLeaves,
  wipeMaster,
  type PasskeyAssertionLike,
  type PqIdentity,
} from "../src/pq/identity.js";
import { metadataHashV2, tokenMetaBorsh, validateTokenMeta } from "../src/metadata/record.js";
import { defaultLaunchWindow, launchWindowIsValid, unixNowSecs, validateLaunchWindow } from "../src/launch/window.js";
import { decodeAttestation, decodeIdentity } from "../src/launch/accounts.js";
import { attestationAddress, identityAddress, identityAddressFromId, tokenMetaAddress } from "../src/pda.js";
import { masterFromPhrase } from "../src/pq/keys.js";
import { leafProbeKey, lmsKeygenSync, lmsVerify, memoryTreeCacheStore, secretLeafProbeStart, signLeafDeterministic, type LmsKeyPair } from "../src/pq/lms.js";

interface Meta {
  name: string | null;
  symbol: string | null;
  flags: number;
  uri: string | null;
  doc: string | null;
  nameHex: string;
  symbolHex: string;
  uriHex: string;
  docHex: string;
}
interface Terms {
  notBefore: number;
  notAfter: number;
  rulesHash?: string;
}
interface LmsVectors {
  parameters: {
    attestMessageTag: string;
    attestMessageLen: number;
    metadataHashTag: string;
    leafProbeTag: string;
    leafWarnAtUsed: number;
    identitySeed: string;
    attestationSeed: string;
    identityAccountLen: number;
    attestationAccountLen: number;
    launchpad: string;
    launchSeeds: string[];
    attestationOffsets: Record<"launch" | "pqIdentity" | "leaf" | "metadataHash" | "rulesHash" | "messageHash" | "slot" | "notBefore" | "notAfter" | "signatureLen" | "signature", number>;
    attestationVersion: number;
    discriminators: Record<"identity" | "attestation" | "launchAttested" | "pqLeafConsumed", string>;
    launchWindow: { minSecs: number; maxSecs: number; maxLeadSecs: number };
    metadataLimits: {
      maxNameLen: number;
      maxSymbolLen: number;
      maxUriLen: number;
      maxDocLen: number;
      examples: { name: string; metadata: Meta; nameBytes: number; nameChars: number; symbolBytes: number; symbolChars: number; valid: boolean }[];
    };
  };
  derivation: { master: string; seedTag: string; idTag: string; maxCluster: number; cases: { cluster: number; index: number; path: string; seed: string; i: string }[] };
  identity: { cluster: number; index: number; seed: string; i: string; publicKey: string; identityId: string; identityAccount: string };
  metadata: { name: string; symbol: string; flags: number; uri: string; doc: string; borsh: string; hash: string; tokenMetaAccount: string };
  attestation: {
    launchSeed: string;
    launch: string;
    launchBytes: string;
    paramsHash: string;
    creator: string;
    creatorBytes: string;
    programBytes: string;
    metadataHash: string;
    rulesHash: string;
    notBefore: number;
    notAfter: number;
    landsAt: number;
    message: string;
    messageHash: string;
    attestationAccount: string;
    leafProbeStart: number;
  };
  signatures: { q: number; signature: string }[];
  accounts: {
    identity: { address: string; bump: number; usedLeaves: number[]; data: string };
    attestation: { address: string; bump: number; leaf: number; slot: number; data: string };
  };
  events: { launchAttested: { leaf: number; slot: number; data: string }; pqLeafConsumed: { leaf: number; data: string } };
  bitmap: { q: number; byte: number; mask: number }[];
  leafSelection: { name: string; probeStart: number; used: string; usedCount: number; next: number | null }[];
  burnOnly: {
    landsAt: number;
    emptyAttestation: string;
    cases: { name: string; q: number; probeStart: number; publicKey: string; identityId: string; identityAccount: string; metadata: Meta; metadataHash: string; terms: Terms; message: string; signature: string; event: string }[];
  };
  passkey: { prfSalt: string; prfOutput: string; hkdfSalt: string; hkdfInfo: string; length: number; entropy: string };
}

const V = JSON.parse(readFileSync(new URL("./vectors/lms.json", import.meta.url), "utf8")) as LmsVectors;
const A = V.attestation;
const master = fromHex(V.derivation.master);
const message = fromHex(A.message);
const clusterOf = (id: number): Cluster => (Object.keys(CLUSTERS) as Cluster[]).find((c) => CLUSTERS[c].id === id)!;
/** A vector record's exact bytes (some are not UTF-8 on purpose). */
const metaBytes = (m: Meta) => ({ name: fromHex(m.nameHex), symbol: fromHex(m.symbolHex), flags: m.flags, uri: fromHex(m.uriHex), doc: fromHex(m.docHex) });
const terms = (t: Terms) => ({ notBefore: BigInt(t.notBefore), notAfter: BigInt(t.notAfter), rulesHash: fromHex(t.rulesHash ?? "00".repeat(32)) });
const baseFields = { launch: new PublicKey(fromHex(A.launchBytes)), paramsHash: fromHex(A.paramsHash), creator: new PublicKey(fromHex(A.creatorBytes)) };
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

let identity0: PqIdentity;
let identity1: LmsKeyPair;

beforeAll(async () => {
  identity0 = await deriveIdentity(master, "localnet", 0);
  identity1 = lmsKeygenSync(deriveIdentityKey(master, "localnet", 1));
});

describe("A12 derivation (vectors: derivation, identity)", () => {
  it("reproduces SEED, I and the path of every case", () => {
    expect([IDENTITY_SEED_TAG, IDENTITY_ID_TAG, MAX_IDENTITY_CLUSTER]).toEqual([V.derivation.seedTag, V.derivation.idTag, V.derivation.maxCluster]);
    expect(V.derivation.cases.length).toBe(6);
    for (const c of V.derivation.cases) {
      const cluster = clusterOf(c.cluster);
      expect(toHex(identityPath(cluster, c.index))).toBe(c.path);
      const sk = deriveIdentityKey(master, cluster, c.index);
      expect(toHex(sk.seed), `${cluster} ${c.index}`).toBe(c.seed);
      expect(toHex(sk.id), `${cluster} ${c.index}`).toBe(c.i);
      // Written out from the definition.
      expect(toHex(sk.seed)).toBe(toHex(sha256(concatBytes([utf8(V.derivation.seedTag), master, fromHex(c.path)]))));
    }
  });

  it("refuses an all-zero master, a bad index and an unknown cluster", () => {
    expect(() => deriveIdentityKey(new Uint8Array(64), "localnet", 0)).toThrow(/all-zero/);
    expect(() => deriveIdentityKey(master.subarray(1), "localnet", 0)).toThrow(/64-byte/);
    const one = new Uint8Array(64);
    one[63] = 1;
    expect(deriveIdentityKey(one, "localnet", 0).seed.length).toBe(32);
    for (const i of [-1, 2 ** 32, 1.5]) expect(() => deriveIdentityKey(master, "localnet", i)).toThrow(/u32/);
    expect(() => deriveIdentityKey(master, "testnet" as Cluster, 0)).toThrow(/cluster/);
  });

  it("deriveIdentity gives the vector identity: public key, identity id, identity account", () => {
    expect(identity0.cluster).toBe(clusterOf(V.identity.cluster));
    expect(toHex(identity0.publicKey)).toBe(V.identity.publicKey);
    expect(toHex(identity0.identityId)).toBe(V.identity.identityId);
    expect(toHex(identityId(identity0.publicKey))).toBe(V.identity.identityId);
    expect(identity0.address.toBase58()).toBe(V.identity.identityAccount);
    expect(identityAddressFromId(identity0.identityId).toBase58()).toBe(V.accounts.identity.address);
    expect(identityAddress(identity0.publicKey).toBase58()).toBe(V.accounts.identity.address);
    expect(PublicKey.findProgramAddressSync([utf8(V.parameters.identitySeed), identity0.identityId], new PublicKey(V.parameters.launchpad))[1]).toBe(V.accounts.identity.bump);
  });

  it("deriveIdentityFromPhrase is deriveIdentity of the phrase's master (the cached tree's tag proves the same SEED and I)", async () => {
    const cache = memoryTreeCacheStore();
    const fromPhrase = await deriveIdentityFromPhrase(PHRASE, "devnet", 3, { cache });
    const rejected: unknown[] = [];
    let progress = 0;
    const fromMaster = await deriveIdentity(importMaster(PHRASE).master, "devnet", 3, { cache, onCacheRejected: (e) => rejected.push(e), onProgress: () => progress++ });
    expect(rejected).toEqual([]);
    expect(progress).toBe(1); // loaded from the cache: no key generation
    expect(toHex(fromMaster.publicKey)).toBe(toHex(fromPhrase.publicKey));
    expect(toHex(fromPhrase.keyPair.id)).toBe(toHex(deriveIdentityKey(masterFromPhrase(PHRASE), "devnet", 3).id));
    await expect(deriveIdentityFromPhrase(`${PHRASE} legal`, "devnet", 3)).rejects.toThrow(/24 words/);
  });
});

describe("passkey (A12): PRF -> HKDF entropy -> 24 words -> master", () => {
  const prf = fromHex(V.passkey.prfOutput);

  it("the HKDF entropy and the constants are the vectors'", () => {
    expect([PASSKEY_PRF_SALT, PASSKEY_HKDF_SALT, PASSKEY_HKDF_INFO]).toEqual([V.passkey.prfSalt, V.passkey.hkdfSalt, V.passkey.hkdfInfo]);
    expect(toHex(passkeyEntropy(prf))).toBe(V.passkey.entropy);
    expect(toHex(passkeyPrfSalt())).toBe(toHex(utf8(V.passkey.prfSalt)));
  });

  it("backup words reproduce the master and the identity exactly (round trip)", () => {
    const pm = deriveMasterFromPasskeyPrf(prf, { userVerified: true });
    expect(toHex(pm.entropy)).toBe(V.passkey.entropy);
    const words = exportMasterAsPhrase(pm);
    expect(words.split(" ").length).toBe(24);
    expect(words).toBe(entropyToMnemonic(fromHex(V.passkey.entropy), wordlist));
    expect(toHex(pm.master)).toBe(toHex(masterFromPhrase(words)));
    const restored = importMaster(words);
    expect(toHex(restored.master)).toBe(toHex(pm.master));
    expect(toHex(restored.entropy)).toBe(V.passkey.entropy);
    for (const c of ["mainnet", "devnet", "localnet"] as const) {
      for (const i of [0, 7]) {
        const a = deriveIdentityKey(pm.master, c, i);
        const b = deriveIdentityKey(restored.master, c, i);
        expect([toHex(a.seed), toHex(a.id)]).toEqual([toHex(b.seed), toHex(b.id)]);
      }
    }
    expect(exportMasterAsPhrase(restored)).toBe(words);
    wipeMaster(restored);
    expect(restored.master.every((b) => b === 0) && restored.entropy.every((b) => b === 0)).toBe(true);
  });

  it("refuses an unverified user, a bad PRF output, a bare seed and a master that is not its entropy's", () => {
    expect(() => deriveMasterFromPasskeyPrf(prf, { userVerified: false })).toThrow(/user-verified/);
    expect(() => passkeyEntropy(prf.subarray(1))).toThrow(/32 bytes/);
    expect(() => passkeyEntropy(new Uint8Array(32))).toThrow(/all-zero/);
    const pm = deriveMasterFromPasskeyPrf(prf, { userVerified: true });
    expect(() => exportMasterAsPhrase(pm.master as unknown as Parameters<typeof exportMasterAsPhrase>[0])).toThrow(/cannot be turned back into words/);
    expect(() => exportMasterAsPhrase({ entropy: pm.entropy, master: masterFromPhrase(PHRASE) })).toThrow(/different master/);
    expect(() => exportMasterAsPhrase({ entropy: new Uint8Array(32), master: pm.master })).toThrow(/all-zero/);
  });

  const rpId = "noised.fun";
  const authData = (flags: number, rp = rpId) => concatBytes([sha256(utf8(rp)), Uint8Array.of(flags), new Uint8Array(4)]);
  /** A fresh ArrayBuffer holding `b` (what browsers return). */
  const ab = (b: Uint8Array): ArrayBuffer => {
    const out = new ArrayBuffer(b.length);
    new Uint8Array(out).set(b);
    return out;
  };
  const assertion = (flags: number, first: Uint8Array | null = prf, rp = rpId): PasskeyAssertionLike => ({
    authenticatorData: ab(authData(flags, rp)),
    clientExtensionResults: { prf: { results: first === null ? {} : { first: ab(first) } } },
  });

  it("reads the PRF only from a user-verified assertion for this RP ID", () => {
    expect(toHex(passkeyPrfFromAssertion(assertion(0x05), { rpId }).prfOutput)).toBe(V.passkey.prfOutput);
    expect(toHex(deriveMasterFromPasskeyAssertion(assertion(0x05), { rpId }).entropy)).toBe(V.passkey.entropy);
    expect(() => passkeyPrfFromAssertion(assertion(0x01), { rpId })).toThrow(/did not verify the user/);
    expect(() => passkeyPrfFromAssertion(assertion(0x04), { rpId })).toThrow(/user presence/);
    expect(() => passkeyPrfFromAssertion(assertion(0x05, prf, "evil.example"), { rpId })).toThrow(/not for the RP ID/);
    expect(() => passkeyPrfFromAssertion(assertion(0x05, null), { rpId })).toThrow(/no PRF output/);
    expect(() => passkeyPrfFromAssertion(assertion(0x05, prf.subarray(1)), { rpId })).toThrow(/32 bytes/);
    expect(() => passkeyPrfFromAssertion({ ...assertion(0x05), authenticatorData: new Uint8Array(36) }, { rpId })).toThrow(/too short/);
  });

  it("builds WebAuthn creation and request options (pure data)", () => {
    const userId = new Uint8Array(16).fill(7);
    const challenge = new Uint8Array(32).fill(9);
    const c = passkeyCreationOptions({ rpId, rpName: "Noised", userName: "creator", userId, challenge, attachment: "platform", excludeCredentialIds: [Uint8Array.of(1, 2)] });
    expect(c.rp).toEqual({ id: rpId, name: "Noised" });
    expect([toHex(c.user.id), c.user.name, c.user.displayName]).toEqual([toHex(userId), "creator", "creator"]);
    expect(toHex(c.challenge)).toBe(toHex(challenge));
    expect(c.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "required", authenticatorAttachment: "platform" });
    expect(c.extensions).toEqual({ prf: {} });
    expect(c.attestation).toBe("none");
    expect(c.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    expect(c.excludeCredentials.map((x) => toHex(x.id))).toEqual(["0102"]);
    expect(c.user.id.buffer).toBeInstanceOf(ArrayBuffer);
    // Defaults: 16 random user-id bytes, 32 random challenge bytes.
    const d = passkeyCreationOptions({ rpId, rpName: "Noised", userName: "creator" });
    expect([d.user.id.length, d.challenge.length]).toEqual([16, 32]);
    expect(toHex(d.user.id)).not.toBe(toHex(passkeyCreationOptions({ rpId, rpName: "Noised", userName: "creator" }).user.id));
    expect(d.authenticatorSelection).not.toHaveProperty("authenticatorAttachment");

    const r = passkeyRequestOptions({ rpId, challenge, credentialIds: [Uint8Array.of(3)] });
    expect(r.userVerification).toBe("required");
    expect(toHex(r.extensions.prf.eval.first)).toBe(toHex(utf8(V.passkey.prfSalt)));
    expect(r.allowCredentials).toEqual([{ type: "public-key", id: Uint8Array.of(3) }]);
    expect(r.rpId).toBe(rpId);
    expect(passkeyRequestOptions({ rpId }).challenge.length).toBe(32);
    expect(() => passkeyRequestOptions({ rpId, challenge: new Uint8Array(8) })).toThrow(/16 bytes/);
  });

  it("accepts only bare lower-case host names as RP ID", () => {
    for (const ok of ["noised.fun", "localhost", "app.example.co.uk", "xn--bcher-kva.example"]) expect(() => checkPasskeyRpId(ok)).not.toThrow();
    for (const bad of ["127.0.0.1", "[::1]", "::1", "https://noised.fun", "noised.fun:443", "Noised.fun", "", "noised.fun/", "noised.fun.", "-x.app"]) {
      expect(() => checkPasskeyRpId(bad), bad).toThrow(/RP ID/);
    }
    expect(() => passkeyCreationOptions({ rpId: "127.0.0.1", rpName: "x", userName: "x" })).toThrow(/IP address/);
  });
});

describe("accounts, events and the bitmap (vectors: accounts, events, bitmap, attestationOffsets)", () => {
  it("bitmap: least significant bit first", () => {
    for (const b of V.bitmap) {
      const used = new Uint8Array(LEAF_BITMAP_LEN);
      expect(markLeafUsed(used, b.q)).toBe(true);
      expect(markLeafUsed(used, b.q)).toBe(false);
      const expected = new Uint8Array(LEAF_BITMAP_LEN);
      expected[b.byte] = b.mask;
      expect(toHex(used)).toBe(toHex(expected));
      expect(leafUsed(used, b.q)).toBe(true);
      expect(usedLeaves(used)).toEqual([b.q]);
    }
    expect(() => leafUsed(new Uint8Array(LEAF_BITMAP_LEN), 1024)).toThrow(/leaf/);
    expect(() => usedLeafCount(new Uint8Array(127))).toThrow(/128 bytes/);
  });

  it("decodes the Identity account the vector attestation leaves (launch/accounts.ts decodeIdentity) into the bitmap", () => {
    const address = new PublicKey(V.accounts.identity.address);
    const data = fromHex(V.accounts.identity.data);
    expect(data.length).toBe(V.parameters.identityAccountLen);
    expect(toHex(data.subarray(0, 8))).toBe(V.parameters.discriminators.identity);
    const acc = decodeIdentity(address, data);
    expect([acc.version, acc.bump, acc.usedCount]).toEqual([1, V.accounts.identity.bump, 1]);
    expect(toHex(acc.lmsPublicKey)).toBe(V.identity.publicKey);
    expect(toHex(acc.identityId)).toBe(V.identity.identityId);
    expect(usedLeaves(acc.used)).toEqual(V.accounts.identity.usedLeaves);
    expect(usedLeafCount(acc.used)).toBe(acc.usedCount);
    expect(leafUsed(acc.used, 511) && !leafUsed(acc.used, 510)).toBe(true);
    // The next leaf for the vector message, given this account.
    expect(nextFreeLeaf(acc.used, 511)).toBe(512);
    // Refusals: another address, a used count that is not the bitmap's.
    expect(() => decodeIdentity(new PublicKey(V.accounts.attestation.address), data)).toThrow(/not the PDA/);
    const badCount = Uint8Array.from(data);
    badCount[194] = 2;
    expect(() => decodeIdentity(address, badCount)).toThrow(/bitmap/);
    // Only what attest_launch writes is an identity: version 1, a key of the LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4 types
    // (SDK v2 follow-up; such an account is still at its own PDA, so the PDA check alone would accept it).
    for (const version of [0, 2]) {
      const other = Uint8Array.from(data);
      other[8] = version;
      expect(() => decodeIdentity(address, other), String(version)).toThrow(/version/);
    }
    for (const [at, type] of [[13, 5], [17, 4]] as const) {
      const other = Uint8Array.from(data);
      other[at] = type;
      const otherKey = other.slice(10, 10 + PQ_IDENTITY.PUBLIC_KEY_LEN);
      expect(() => decodeIdentity(identityAddress(otherKey), other), `type ${type}`).toThrow(/typecodes 6 \/ 3/);
    }
  });

  it("decodes the Attestation account at the documented offsets (launch/accounts.ts decodeAttestation), and the empty burn-only one", () => {
    const data = fromHex(V.accounts.attestation.data);
    const o = V.parameters.attestationOffsets;
    expect(data.length).toBe(V.parameters.attestationAccountLen);
    expect(toHex(data.subarray(0, 8))).toBe(V.parameters.discriminators.attestation);
    const address = new PublicKey(V.accounts.attestation.address);
    const att = decodeAttestation(address, data);
    const dv = new DataView(data.buffer, data.byteOffset);
    expect(att.version).toBe(V.parameters.attestationVersion);
    expect(att.version).toBe(3);
    expect(toHex(att.rulesHash)).toBe(toHex(data.subarray(o.rulesHash, o.rulesHash + 32)));
    expect(toHex(att.rulesHash)).toBe(A.rulesHash);
    expect(att.attested).toBe(true);
    expect(att.bump).toBe(V.accounts.attestation.bump);
    expect(att.launch.toBase58()).toBe(A.launch);
    expect(toHex(att.launch.toBytes())).toBe(toHex(data.subarray(o.launch, o.launch + 32)));
    expect(toHex(att.pqIdentity)).toBe(toHex(data.subarray(o.pqIdentity, o.pqIdentity + 32)));
    expect(toHex(att.pqIdentity)).toBe(V.identity.identityId);
    expect(att.leaf).toBe(dv.getUint16(o.leaf, true));
    expect(att.leaf).toBe(V.accounts.attestation.leaf);
    expect(toHex(att.metadataHash)).toBe(toHex(data.subarray(o.metadataHash, o.metadataHash + 32)));
    expect(toHex(att.metadataHash)).toBe(A.metadataHash);
    expect(toHex(att.messageHash)).toBe(toHex(data.subarray(o.messageHash, o.messageHash + 32)));
    expect(toHex(att.messageHash)).toBe(A.messageHash);
    expect(att.slot).toBe(dv.getBigUint64(o.slot, true));
    expect(att.slot).toBe(BigInt(V.accounts.attestation.slot));
    expect([att.notBefore, att.notAfter]).toEqual([dv.getBigInt64(o.notBefore, true), dv.getBigInt64(o.notAfter, true)]);
    expect([att.notBefore, att.notAfter]).toEqual([BigInt(A.notBefore), BigInt(A.notAfter)]);
    expect(dv.getUint32(o.signatureLen, true)).toBe(2508);
    expect(toHex(att.signature)).toBe(toHex(data.subarray(o.signature)));
    expect(toHex(att.signature)).toBe(V.signatures.find((s) => s.q === 511)!.signature);
    expect(attestationAddress(att.launch).toBase58()).toBe(V.accounts.attestation.address);
    expect(attestationAddress(att.launch).toBase58()).toBe(A.attestationAccount);
    expect(attestationAttestsMessage(att, message)).toBe(true);
    expect(attestationAttestsMessage(att, fromHex(V.burnOnly.cases[0]!.message))).toBe(false);

    const empty = decodeAttestation(address, fromHex(V.burnOnly.emptyAttestation));
    expect([empty.version, empty.attested, empty.bump, empty.signature.length]).toEqual([0, false, V.accounts.attestation.bump, 0]);
    expect(attestationAttestsMessage(empty, message)).toBe(false);
    // Version 0 never attests, even holding this message's hash; nor does a version-1 (message v1) one.
    const unattested = Uint8Array.from(data);
    unattested[8] = 0;
    expect(decodeAttestation(address, unattested).attested).toBe(false);
    unattested[8] = 1;
    expect(decodeAttestation(address, unattested).attested).toBe(false);
    unattested[8] = 0;
    expect(attestationAttestsMessage(decodeAttestation(address, unattested), message)).toBe(false);
    expect(attestationAttestsMessage({ attested: true, messageHash: att.messageHash }, message)).toBe(true);
    expect(attestationAttestsMessage({ attested: false, messageHash: att.messageHash }, message)).toBe(false);
  });

  it("decodes LaunchAttested and PqLeafConsumed", () => {
    const d = V.parameters.discriminators;
    const la = decodePqAttestEvent(concatBytes([fromHex(d.launchAttested), fromHex(V.events.launchAttested.data)]));
    expect(la).not.toBeNull();
    if (la?.name !== "LaunchAttested") throw new Error("expected LaunchAttested");
    expect([la.launch.toBase58(), toHex(la.pqIdentity), la.leaf, toHex(la.metadataHash), la.slot]).toEqual([A.launch, V.identity.identityId, V.events.launchAttested.leaf, A.metadataHash, BigInt(V.events.launchAttested.slot)]);
    expect([la.notBefore, la.notAfter]).toEqual([BigInt(A.notBefore), BigInt(A.notAfter)]);
    expect("metadataJsonSha256" in la).toBe(false);
    const pc = decodePqAttestEvent(concatBytes([fromHex(d.pqLeafConsumed), fromHex(V.events.pqLeafConsumed.data)]));
    if (pc?.name !== "PqLeafConsumed") throw new Error("expected PqLeafConsumed");
    expect([toHex(pc.pqIdentity), pc.leaf, pc.launch.toBase58()]).toEqual([V.identity.identityId, V.events.pqLeafConsumed.leaf, A.launch]);
    for (const c of V.burnOnly.cases) {
      const e = decodePqAttestEvent(concatBytes([fromHex(d.pqLeafConsumed), fromHex(c.event)]));
      if (e?.name !== "PqLeafConsumed") throw new Error("expected PqLeafConsumed");
      expect([toHex(e.pqIdentity), e.leaf, e.launch.toBase58()]).toEqual([c.identityId, c.q, A.launch]);
    }
    expect(decodePqAttestEvent(fromHex(V.events.launchAttested.data))).toBeNull();
  });
});

describe("leaf choice (vectors: leafProbe, leafSelection, burnOnly; the secret probe v2)", () => {
  it("the RETIRED public probe v1 of the vector message (reference vectors only)", () => {
    expect(LEAF_PROBE_TAG).toBe(V.parameters.leafProbeTag);
    expect(leafProbeStart(fromHex(V.identity.i), message)).toBe(A.leafProbeStart);
    const h = sha256(concatBytes([utf8(V.parameters.leafProbeTag), fromHex(V.identity.i), message]));
    expect(leafProbeStart(fromHex(V.identity.i), message)).toBe(((h[0]! << 8) | h[1]!) % 1024);
    expect(() => leafProbeStart(fromHex(V.identity.publicKey), message)).toThrow(/16 bytes/);
    expect(() => leafProbeStart(fromHex(V.identity.i), A.message as unknown as Uint8Array)).toThrow(/Uint8Array/);
  });

  it("first clear bit from the start, +1 with wrap-around; null when exhausted", () => {
    expect(V.leafSelection.length).toBe(5);
    for (const c of V.leafSelection) {
      const used = fromHex(c.used);
      expect(usedLeafCount(used), c.name).toBe(c.usedCount);
      expect(nextFreeLeaf(used, c.probeStart), c.name).toBe(c.next);
    }
    // Leaves in the client's records are skipped like used ones.
    expect(nextFreeLeaf(new Uint8Array(128), 1022, (q) => q === 1022 || q === 1023)).toBe(0);
  });

  it("the secret probe v2 (audit 4, ID-F1a): HMAC-SHA256 under a key derived from SEED, deterministic per message, unpredictable without SEED", () => {
    expect([PQ_IDENTITY.LEAF_PROBE_V2_TAG, PQ_IDENTITY.LEAF_PROBE_KEY_TAG]).toEqual(["phalanx/pq/identity/leaf/v2", "phalanx/pq/identity/leaf/v2/key"]);
    const sk = deriveIdentityKey(master, "localnet", 0);
    const probeKey = hmac(sha256, sk.seed, concatBytes([utf8("phalanx/pq/identity/leaf/v2/key"), sk.id]));
    const h = hmac(sha256, probeKey, concatBytes([utf8("phalanx/pq/identity/leaf/v2"), message]));
    const start = identity0.keyPair.leafProbeStart(message);
    expect(start).toBe(((h[0]! << 8) | h[1]!) % 1024);
    expect(toHex(leafProbeKey(sk))).toBe(toHex(probeKey));
    expect(secretLeafProbeStart(probeKey, message)).toBe(start);
    // Deterministic per message (a retry finds the same leaf); another message, or another identity, starts elsewhere.
    expect(identity0.keyPair.leafProbeStart(message)).toBe(start);
    const starts = new Set(Array.from({ length: 64 }, (_, i) => identity0.keyPair.leafProbeStart(concatBytes([message, Uint8Array.of(i)]))));
    expect(starts.size).toBeGreaterThan(55);
    // Nothing public gives it: the retired v1 probe (I and the message only) is another number here.
    expect(start).not.toBe(leafProbeStart(fromHex(V.identity.i), message));
    expect(identity1.leafProbeStart(message)).not.toBe(start);
    expect(() => identity0.keyPair.leafProbeStart("x" as unknown as Uint8Array)).toThrow(/Uint8Array/);
  });

  it("chooseLeaf: the secret probe and the records only (the bitmap never moves it), unknown used leaves, and the 1,000-leaf warning", () => {
    expect(LEAF_WARN_AT_USED).toBe(V.parameters.leafWarnAtUsed);
    const kp = identity0.keyPair;
    const start = kp.leafProbeStart(message);
    const fresh = chooseLeaf(kp, message, new Uint8Array(128));
    expect([fresh.leaf, fresh.probeStart, fresh.usedCount, fresh.warn, fresh.exhausted, fresh.unknownUsed, fresh.leafSetOnChain]).toEqual([start, start, 0, false, false, [], false]);
    expect(chooseLeaf(kp, message, new Uint8Array(128), [start, (start + 1) % 1024]).leaf).toBe((start + 2) % 1024);
    // An RPC reporting every other leaf as used cannot steer the choice: it stays at the probe, flagged.
    const allButOne = new Uint8Array(128).fill(0xff);
    allButOne[((start + 7) % 1024) >> 3]! &= ~(1 << ((start + 7) % 1024 & 7));
    const steered = chooseLeaf(kp, message, allButOne);
    expect([steered.leaf, steered.leafSetOnChain, steered.unknownUsed.length]).toEqual([start, true, 1023]);
    // Leaves in the records are known, not unknown.
    expect(chooseLeaf(kp, message, allButOne, [start]).unknownUsed.length).toBe(1022);
    const used = new Uint8Array(128);
    for (let q = 0; q < 999; q++) markLeafUsed(used, q);
    expect(chooseLeaf(kp, message, used).warn).toBe(false);
    expect(chooseLeaf(kp, message, used, [1000]).warn).toBe(true);
    markLeafUsed(used, 999);
    expect(chooseLeaf(kp, message, used).warn).toBe(true);
    // Exhausted only when every leaf is in the records.
    expect(chooseLeaf(kp, message, new Uint8Array(128), Array.from({ length: 1024 }, (_, q) => q))).toMatchObject({ leaf: null, exhausted: true, usedCount: 0 });
    expect(() => chooseLeaf(fromHex(V.identity.publicKey) as unknown as LmsKeyPair, message, used)).toThrow(/LmsKeyPair/);
  });

  it("every burn-only case takes the leaf its message probes to (retired v1 rule), after the cases before it", () => {
    const bitmaps = new Map<string, Uint8Array>();
    for (const c of V.burnOnly.cases) {
      const pk = fromHex(c.publicKey);
      expect(toHex(identityId(pk))).toBe(c.identityId);
      expect(identityAddressFromId(identityId(pk)).toBase58()).toBe(c.identityAccount);
      expect(identityAddress(pk).toBase58()).toBe(c.identityAccount);
      const used = bitmaps.get(c.identityId) ?? new Uint8Array(128);
      bitmaps.set(c.identityId, used);
      const start = leafProbeStart(pk.subarray(8, 24), fromHex(c.message));
      expect(start, c.name).toBe(c.probeStart);
      const q = nextFreeLeaf(used, start)!;
      expect(q, c.name).toBe(c.q);
      markLeafUsed(used, q);
    }
  });
});

describe("the attestation message, metadata and window (vectors: attestation, metadata, metadataLimits, launchWindow, burnOnly)", () => {
  it("builds the 221-byte message v3 byte for byte, and parses it back", () => {
    expect([ATTEST_MESSAGE_TAG, ATTEST_MESSAGE_LEN, METADATA_HASH_TAG]).toEqual([V.parameters.attestMessageTag, V.parameters.attestMessageLen, V.parameters.metadataHashTag]);
    expect(toHex(PROGRAM_IDS.launchpad.toBytes())).toBe(A.programBytes);
    const fields = { ...baseFields, metadataHash: fromHex(A.metadataHash), notBefore: BigInt(A.notBefore), notAfter: BigInt(A.notAfter) };
    const msg = attestationMessage(fields);
    expect(msg).toHaveLength(221);
    expect(toHex(msg)).toBe(A.message);
    expect(toHex(sha256(msg))).toBe(A.messageHash);
    expect(toHex(attestationMessage({ ...fields, programId: PROGRAM_IDS.launchpad }))).toBe(A.message);
    const parsed = parseAttestationMessage(msg);
    expect([parsed.programId.toBase58(), parsed.launch.toBase58(), parsed.creator.toBase58()]).toEqual([V.parameters.launchpad, A.launch, A.creator]);
    expect([toHex(parsed.paramsHash), toHex(parsed.metadataHash), parsed.notBefore, parsed.notAfter]).toEqual([A.paramsHash, A.metadataHash, BigInt(A.notBefore), BigInt(A.notAfter)]);
    // i64 little-endian, negative values included.
    expect(parseAttestationMessage(attestationMessage({ ...fields, notBefore: -5n, notAfter: (1n << 63n) - 1n })).notBefore).toBe(-5n);
    expect(() => attestationMessage({ ...fields, notBefore: 1 as unknown as bigint })).toThrow(/bigint/);
    expect(() => attestationMessage({ ...fields, notAfter: 1n << 63n })).toThrow(/i64/);
    expect(() => attestationMessage({ ...fields, paramsHash: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => parseAttestationMessage(concatBytes([utf8("PHX-ATTEST-V1"), msg.subarray(13)]))).toThrow(/PHX-ATTEST-V3/);
    expect(() => parseAttestationMessage(concatBytes([msg, new Uint8Array(32)]))).toThrow(/221 bytes/);
    // A retired 189-byte v2 message is refused (it can never land: the program builds only v3).
    expect(() => parseAttestationMessage(msg.subarray(0, 189))).toThrow(/221 bytes/);
    // The rules hash sits between the metadata hash and the window.
    const withRules = attestationMessage({ ...fields, rulesHash: new Uint8Array(32).fill(7) });
    expect(toHex(withRules.subarray(13 + 5 * 32, 13 + 6 * 32))).toBe("07".repeat(32));
    expect(toHex(parseAttestationMessage(withRules).rulesHash)).toBe("07".repeat(32));
    expect(toHex(parsed.rulesHash)).toBe(A.rulesHash);
    // The launch is the PDA ["launch", creator, launch_seed].
    const seeds = V.parameters.launchSeeds;
    expect(seeds).toEqual(["launch", "creator", "launchSeed"]);
    expect(PublicKey.findProgramAddressSync([utf8("launch"), fromHex(A.creatorBytes), fromHex(A.launchSeed)], PROGRAM_IDS.launchpad)[0].toBase58()).toBe(A.launch);
  });

  it("the vector record: borsh, metadata_hash_v2 and the record's address", () => {
    const m = V.metadata;
    expect(toHex(tokenMetaBorsh(m))).toBe(m.borsh);
    expect(toHex(metadataHashV2(m))).toBe(m.hash);
    expect(toHex(metadataHashV2({ name: utf8(m.name), symbol: utf8(m.symbol), flags: m.flags, uri: utf8(m.uri), doc: utf8(m.doc) }))).toBe(m.hash);
    expect(m.hash).toBe(A.metadataHash);
    expect(tokenMetaAddress(new PublicKey(A.launch), fromHex(m.hash)).toBase58()).toBe(m.tokenMetaAccount);
  });

  it("every burn-only message and metadata hash (non-UTF-8 bytes included)", () => {
    for (const c of V.burnOnly.cases) {
      const h = metadataHashV2(metaBytes(c.metadata));
      expect(toHex(h), c.name).toBe(c.metadataHash);
      const msg = attestationMessage({ ...baseFields, metadataHash: h, ...terms(c.terms) });
      expect(toHex(msg), c.name).toBe(c.message);
    }
  });

  it("record limits are UTF-8 bytes: every example of the vectors, as text and as bytes", () => {
    const L = V.parameters.metadataLimits;
    expect([L.maxNameLen, L.maxSymbolLen, L.maxUriLen, L.maxDocLen]).toEqual([32, 10, 200, 3_072]);
    for (const e of L.examples) {
      const m = e.metadata;
      expect(validateTokenMeta({ name: m.name!, symbol: m.symbol!, flags: m.flags, uri: m.uri!, doc: m.doc! }).ok, e.name).toBe(e.valid);
      expect(validateTokenMeta(metaBytes(m)).ok, e.name).toBe(e.valid);
      expect([utf8(m.name!).length, utf8(m.symbol!).length]).toEqual([e.nameBytes, e.symbolBytes]);
    }
    // The classic mistake: JavaScript length counts UTF-16 units.
    const euros = "€".repeat(11);
    expect(euros.length).toBe(11);
    expect(validateTokenMeta({ name: euros, symbol: "S" })).toEqual({ ok: false, error: { code: 6016, name: "InvalidMetadata" }, errors: ["name: must be 1..=32 bytes of UTF-8 (is 33)"] });
    // In the program's order: lengths (6046) before name and symbol (6016) before the uri modes (6045).
    expect(validateTokenMeta({ name: "N", symbol: "", uri: "x".repeat(201) })).toEqual({
      ok: false,
      error: { code: 6046, name: "MetadataTooLong" },
      errors: ["uri: must be at most 200 bytes (is 201)", "symbol: must be 1..=10 bytes of UTF-8 (is 0)", "uri: must be empty unless the external-uri flag is set"],
    });
    expect(validateTokenMeta({ name: "N".repeat(32), symbol: "S".repeat(10) }).ok).toBe(true);
    expect(validateTokenMeta({ name: "N\uD800", symbol: "S" }).errors).toEqual(["name: contains an unpaired UTF-16 surrogate (not valid text)"]);
  });

  it("the burn-only records that can never be published are refused before signing; the vector record is accepted", () => {
    expect(validateTokenMeta(V.metadata)).toEqual({ ok: true, error: null, errors: [] });
    const refused = V.burnOnly.cases.filter((c) => !validateTokenMeta(metaBytes(c.metadata)).ok).map((c) => c.name);
    expect(refused).toEqual(["a name of 11 characters and 33 UTF-8 bytes", "an empty symbol", "a name that is not UTF-8"]);
    const notUtf8 = V.burnOnly.cases[2]!.metadata;
    expect(validateTokenMeta(metaBytes(notUtf8))).toEqual({ ok: false, error: { code: 102, name: "InstructionDidNotDeserialize" }, errors: ["name: is not valid UTF-8"] });
  });

  it("the window rule is the program's: every burn-only window fails, the vector window passes", () => {
    const W = V.parameters.launchWindow;
    expect([MIN_LAUNCH_WINDOW_SECS, MAX_LAUNCH_WINDOW_SECS, MAX_LAUNCH_LEAD_SECS]).toEqual([BigInt(W.minSecs), BigInt(W.maxSecs), BigInt(W.maxLeadSecs)]);
    const landsAt = BigInt(V.burnOnly.landsAt);
    expect(landsAt).toBe(BigInt(A.landsAt));
    expect(launchWindowIsValid(landsAt, BigInt(A.notBefore), BigInt(A.notAfter))).toBe(true);
    const byWindow = V.burnOnly.cases.filter((c) => !launchWindowIsValid(landsAt, BigInt(c.terms.notBefore), BigInt(c.terms.notAfter))).map((c) => c.name);
    expect(byWindow).toEqual([
      "a window of an hour and a second",
      "a window that closed a second before it landed",
      "a window opening a week and a second after it landed",
      "a window in milliseconds",
    ]);
    // Boundaries.
    expect(launchWindowIsValid(0n, 0n, 60n)).toBe(true);
    expect(launchWindowIsValid(0n, 0n, 59n)).toBe(false);
    // Audit round 3 F1: at least 60 s of the window must be left when it lands (max(now, nb) + 60 <= na).
    expect(launchWindowIsValid(60n, 0n, 120n)).toBe(true);
    expect(launchWindowIsValid(61n, 0n, 120n)).toBe(false);
    expect(launchWindowIsValid(60n, 0n, 60n)).toBe(false); // ends exactly when it lands: nothing left to launch in
    expect(launchWindowIsValid(1n, 0n, 60n)).toBe(false);
    expect(launchWindowIsValid(0n, 0n, 60n)).toBe(true);
    expect(launchWindowIsValid(0n, 604_800n, 604_860n)).toBe(true);
    expect(launchWindowIsValid(0n, 604_801n, 604_861n)).toBe(false);
    expect(() => launchWindowIsValid(0n, 0 as unknown as bigint, 60n)).toThrow(/bigint/);
  });

  it("validateLaunchWindow checks before signing, with a landing margin", () => {
    const now = BigInt(A.landsAt);
    expect(validateLaunchWindow(BigInt(A.notBefore), BigInt(A.notAfter), { nowSecs: now })).toEqual({ ok: true, errors: [] });
    for (const c of V.burnOnly.cases.slice(5, 9)) {
      expect(validateLaunchWindow(BigInt(c.terms.notBefore), BigInt(c.terms.notAfter), { nowSecs: now }).ok, c.name).toBe(false);
    }
    const ms = V.burnOnly.cases[8]!.terms;
    expect(validateLaunchWindow(BigInt(ms.notBefore), BigInt(ms.notAfter), { nowSecs: now }).errors).toEqual([
      "notBefore: looks like milliseconds (Date.now()); use unix seconds",
      "notAfter: looks like milliseconds (Date.now()); use unix seconds",
    ]);
    // Ends 100 s from now: valid at this instant, but not if landing takes up to 300 s (60 s must be left when it lands).
    expect(launchWindowIsValid(now, now - 3000n, now + 100n)).toBe(true);
    expect(validateLaunchWindow(now - 3000n, now + 100n, { nowSecs: now }).errors).toEqual([
      "notAfter: the window ends before the attestation can land with 60 s of it left (allow 300 s to land)",
    ]);
    expect(validateLaunchWindow(now - 3000n, now + 100n, { nowSecs: now, landingMarginSecs: 40n }).ok).toBe(true);
    expect(validateLaunchWindow(now - 3000n, now + 100n, { nowSecs: now, landingMarginSecs: 41n }).ok).toBe(false);
    expect(validateLaunchWindow(now - 3000n, now + 60n, { nowSecs: now, landingMarginSecs: 0n }).ok).toBe(true);
    expect(validateLaunchWindow(now - 3000n, now + 59n, { nowSecs: now, landingMarginSecs: 0n }).ok).toBe(false);
    expect(validateLaunchWindow(now, now + 59n, { nowSecs: now - 1000n }).errors).toEqual(["notAfter: the window must last 60..=3600 seconds (lasts 59)"]);
    expect(validateLaunchWindow(1 as unknown as bigint, 70n, { nowSecs: now }).errors).toEqual(["notBefore: must be a bigint of unix seconds"]);
    const d = defaultLaunchWindow(now + 600n);
    expect(d).toEqual({ notBefore: now + 600n, notAfter: now + 4200n });
    expect(validateLaunchWindow(d.notBefore, d.notAfter, { nowSecs: now }).ok).toBe(true);
    expect(unixNowSecs(1_767_225_600_999)).toBe(1_767_225_600n);
    expect(unixNowSecs()).toBeLessThan(MS_GUARD);
  });
});

const MS_GUARD = 100_000_000_000n;

describe("burn-only signatures (vectors: burnOnly): byte parity, including the same phrase's identity index 1", () => {
  it("every burn-only signature is this SDK's deterministic signature at its leaf", () => {
    expect(V.burnOnly.cases.length).toBe(10);
    for (const c of V.burnOnly.cases) {
      const kp = toHex(identity0.publicKey) === c.publicKey ? identity0.keyPair : identity1;
      expect(toHex(kp.publicKey), c.name).toBe(c.publicKey);
      const msg = fromHex(c.message);
      expect(toHex(signLeafDeterministic(kp, c.q, msg)), c.name).toBe(c.signature);
      expect(lmsVerify(kp.publicKey, msg, fromHex(c.signature))).toBe(c.q);
    }
    expect(toHex(identity1.publicKey)).toBe(V.burnOnly.cases[9]!.publicKey);
  });
});

/**
 * PQ v2 launchpad parity with the Rust side, from
 * test/vectors/lms.json (a byte-identical copy of
 * tests/integration/vectors/lms.json, written by
 * tests/integration/tests/lms_vectors.rs from the launchpad crate):
 *
 * - the creator-seeded Launch PDA `["launch", creator, launch_seed]`, the
 *   identity PDA `["identity", SHA256(0x21 || pk)]` and the attestation PDA;
 * - `Launch` v2, `Identity` and `Attestation` (attested and empty) bytes,
 *   decoded at the documented offsets;
 * - `metadata_hash_v2` over the record's borsh (name, symbol, flags, uri,
 *   doc), the record limits in UTF-8 bytes, the launch-window rule and every
 *   burn-only case;
 * - `attest_launch` instruction data and accounts, the events and the
 *   discriminators and error codes of the IDL;
 * - and, from test/vectors/launchpad_rust.json (generated with the launchpad
 *   crate), borsh(LaunchParams) with `pq_identity`, `params_hash`,
 *   `policy::validate` and the PQ v2 PDAs.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, u32le, utf8, utf8Length } from "../src/codec/bytes.js";
import { buildInstruction } from "../src/codec/ix.js";
import { METADATA, PQ_IDENTITY, POLICY, PROGRAM_IDS, SEEDS } from "../src/constants.js";
import { IDLS, idlCodecs } from "../src/idl/index.js";
import { decodeAttestation, decodeIdentity, decodeLaunch, identityLeafUsed } from "../src/launch/accounts.js";
import { deserializeLaunchParams, serializeLaunchParams } from "../src/launch/builders.js";
import { launchParamsHash } from "../src/launch/hash.js";
import { validateLaunchParams } from "../src/launch/policy.js";
import { metadataHashV2, tokenMetaBorsh, validateTokenMeta } from "../src/metadata/record.js";
import { defaultLaunchWindow, inLaunchWindow, launchWindowIsValid, launchWindowProblems, unixNowSecs, validateLaunchWindow, windowProblemsAt, windowValidAt } from "../src/launch/window.js";
import * as sdk from "../src/index.js";
import { isPqVaultOf, pqVaultMint } from "../src/launch/recipients.js";
import { attestLaunchInstruction, rulesAccountFor } from "../src/pq/attest.js";
import { attestationAddress, identityAddress, identityAddressFromId, launchAddress, launchPdas, payoutVaultAddress, tokenMetaAddress } from "../src/pda.js";
import { readJson } from "./helpers.js";

interface Meta {
  name: string;
  nameHex: string;
  symbol: string;
  symbolHex: string;
  flags: number;
  uri: string;
  uriHex: string;
  doc: string;
  docHex: string;
}
interface LmsVectors {
  parameters: {
    launchpad: string;
    attestMessageLen: number;
    attestMessageTag: string;
    metadataHashTag: string;
    identitySeed: string;
    attestationSeed: string;
    identityIdDomain: number;
    publicKeyLen: number;
    signatureLen: number;
    leaves: number;
    height: number;
    lmsType: number;
    otsType: number;
    leafProbeTag: string;
    leafWarnAtUsed: number;
    attestCuLimit: number;
    attestLoadedAccountsDataLimit: number;
    identityAccountLen: number;
    attestationAccountLen: number;
    payoutVaultAccountLen: number;
    launchAccountLen: number;
    launchOffsets: Record<"creator" | "paramsHash" | "pqIdentity" | "status", number>;
    attestationOffsets: Record<"launch" | "pqIdentity" | "leaf" | "metadataHash" | "rulesHash" | "messageHash" | "slot" | "notBefore" | "notAfter" | "signatureLen" | "signature", number>;
    attestationVersion: number;
    tokenMetaFixedLen: number;
    tokenMetaSeeds: string[];
    launchSeeds: string[];
    payoutVaultSeeds: string[];
    launchWindow: { minSecs: number; maxSecs: number; maxLeadSecs: number };
    metadataLimits: {
      maxNameLen: number;
      maxSymbolLen: number;
      maxUriLen: number;
      maxDocLen: number;
      examples: { name: string; metadata: Meta; nameBytes: number; symbolBytes: number; valid: boolean }[];
    };
    discriminators: Record<string, string>;
    errors: { name: string; number: number }[];
  };
  identity: { publicKey: string; identityId: string; identityAccount: string };
  attestation: {
    launch: string;
    launchSeed: string;
    creator: string;
    paramsHash: string;
    metadataHash: string;
    message: string;
    messageHash: string;
    notBefore: number;
    notAfter: number;
    landsAt: number;
    attestationAccount: string;
  };
  metadata: { name: string; symbol: string; flags: number; uri: string; doc: string; borsh: string; hash: string; tokenMetaAccount: string };
  accounts: {
    launch: { address: string; data: string; status: string };
    identity: { address: string; data: string; usedLeaves: number[] };
    attestation: { address: string; data: string; leaf: number; slot: number; bump: number };
    tokenMeta: { address: string; bump: number; data: string };
  };
  signatures: { q: number; signature: string }[];
  attestLaunch: { data: string; q: number; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; payer: string };
  burnOnly: {
    landsAt: number;
    emptyAttestation: string;
    cases: { name: string; metadata: Meta; metadataHash: string; tokenMetaAccount: string; rulesAccount: string; publicKey: string; identityId: string; terms: { notBefore: number; notAfter: number; rulesHash: string } }[];
  };
  events: { launchAttested: { data: string; leaf: number; slot: number }; pqLeafConsumed: { data: string; leaf: number } };
}

const v = readJson<LmsVectors>("./vectors/lms.json");
const P = v.parameters;
const pk = (s: string): PublicKey => new PublicKey(s);
/** A vector record's exact bytes. */
const bytesOf = (m: Meta) => ({ name: fromHex(m.nameHex), symbol: fromHex(m.symbolHex), flags: m.flags, uri: fromHex(m.uriHex), doc: fromHex(m.docHex) });

describe("PQ v2 constants equal the vectors' parameters", () => {
  it("LMS, message, account sizes, seeds and v1 config words", () => {
    expect(P.launchpad).toBe(PROGRAM_IDS.launchpad.toBase58());
    expect([P.lmsType, P.otsType, P.height, P.leaves, P.publicKeyLen, P.signatureLen, P.identityIdDomain]).toEqual([
      PQ_IDENTITY.LMS_TYPE,
      PQ_IDENTITY.LMOTS_TYPE,
      PQ_IDENTITY.HEIGHT,
      PQ_IDENTITY.LEAVES,
      PQ_IDENTITY.PUBLIC_KEY_LEN,
      PQ_IDENTITY.SIGNATURE_LEN,
      PQ_IDENTITY.IDENTITY_ID_DOMAIN,
    ]);
    expect([P.attestMessageTag, P.attestMessageLen, P.metadataHashTag, P.leafProbeTag, P.leafWarnAtUsed]).toEqual([
      PQ_IDENTITY.ATTEST_MESSAGE_TAG,
      PQ_IDENTITY.ATTEST_MESSAGE_LEN,
      PQ_IDENTITY.METADATA_HASH_TAG,
      PQ_IDENTITY.LEAF_PROBE_TAG,
      PQ_IDENTITY.LEAF_WARN_AT_USED,
    ]);
    expect([P.identityAccountLen, P.attestationAccountLen, P.payoutVaultAccountLen]).toEqual([
      PQ_IDENTITY.IDENTITY_ACCOUNT_LEN,
      PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN,
      PQ_IDENTITY.PAYOUT_VAULT_ACCOUNT_LEN,
    ]);
    expect(idlCodecs().launchpad.accountSize("Launch")).toBe(P.launchAccountLen);
    expect([P.attestCuLimit, P.attestLoadedAccountsDataLimit]).toEqual([PQ_IDENTITY.ATTEST_COMPUTE_UNITS, PQ_IDENTITY.ATTEST_LOADED_ACCOUNTS_BYTES]);
    expect([P.identitySeed, P.attestationSeed]).toEqual([SEEDS.identity, SEEDS.attestation]);
    expect(P.launchSeeds).toEqual([SEEDS.launch, "creator", "launchSeed"]);
    expect(P.payoutVaultSeeds).toEqual([SEEDS.payoutVault, "launch", "vault"]);
    expect([P.launchWindow.minSecs, P.launchWindow.maxSecs, P.launchWindow.maxLeadSecs]).toEqual([
      POLICY.MIN_LAUNCH_WINDOW_SECS,
      POLICY.MAX_LAUNCH_WINDOW_SECS,
      POLICY.MAX_LAUNCH_LEAD_SECS,
    ]);
    expect([P.metadataLimits.maxNameLen, P.metadataLimits.maxSymbolLen, P.metadataLimits.maxUriLen, P.metadataLimits.maxDocLen]).toEqual([POLICY.MAX_NAME_LEN, POLICY.MAX_SYMBOL_LEN, POLICY.MAX_URI_LEN, POLICY.MAX_DOC_LEN]);
    expect([P.attestationVersion, P.tokenMetaFixedLen]).toEqual([PQ_IDENTITY.ATTESTATION_VERSION, METADATA.TOKEN_META_FIXED_LEN]);
    expect(P.tokenMetaSeeds).toEqual([SEEDS.metadata, "launch", "metadataHash"]);
  });

  it("discriminators and error codes are the IDL's", () => {
    const idl = IDLS.launchpad;
    const disc = (list: { name: string; discriminator: number[] }[] | undefined, name: string): string => toHex(Uint8Array.from(list!.find((x) => x.name === name)!.discriminator));
    expect(disc(idl.instructions, "attest_launch")).toBe(P.discriminators["attestLaunch"]);
    expect(disc(idl.accounts, "Attestation")).toBe(P.discriminators["attestation"]);
    expect(disc(idl.accounts, "Identity")).toBe(P.discriminators["identity"]);
    expect(disc(idl.accounts, "Launch")).toBe(P.discriminators["launch"]);
    expect(disc(idl.accounts, "PayoutVault")).toBe(P.discriminators["payoutVault"]);
    expect(disc(idl.events, "LaunchAttested")).toBe(P.discriminators["launchAttested"]);
    expect(disc(idl.events, "PqLeafConsumed")).toBe(P.discriminators["pqLeafConsumed"]);
    expect(disc(idl.instructions, "publish_metadata")).toBe(P.discriminators["publishMetadata"]);
    expect(disc(idl.accounts, "TokenMeta")).toBe(P.discriminators["tokenMeta"]);
    expect(disc(idl.events, "MetadataPublished")).toBe(P.discriminators["metadataPublished"]);
    for (const e of P.errors) expect(idlCodecs().launchpad.errorByCode(e.number)?.name, e.name).toBe(e.name);
  });
});

describe("PDAs (Rust-derived addresses)", () => {
  it("launch = [\"launch\", creator, launch_seed]; its attestation and the identity of the signing key", () => {
    const a = v.attestation;
    const creator = pk(a.creator);
    expect(toHex(creator.toBytes())).toBe(toHex(fromHex((v.attestation as unknown as { creatorBytes: string }).creatorBytes)));
    const launch = launchAddress(creator, fromHex(a.launchSeed));
    expect(launch.toBase58()).toBe(a.launch);
    expect(launchPdas(creator, fromHex(a.launchSeed)).launch.toBase58()).toBe(a.launch);
    // The seed alone (pre-v2) gives another address: a seed cannot be squatted by another creator.
    expect(PublicKey.findProgramAddressSync([utf8("launch"), fromHex(a.launchSeed)], PROGRAM_IDS.launchpad)[0].toBase58()).not.toBe(a.launch);
    expect(launchAddress(pk(v.attestLaunch.payer), fromHex(a.launchSeed)).toBase58()).not.toBe(a.launch);
    expect(attestationAddress(launch).toBase58()).toBe(a.attestationAccount);
    expect(attestationAddress(launch).toBase58()).toBe(v.accounts.attestation.address);
    expect(identityAddress(fromHex(v.identity.publicKey)).toBase58()).toBe(v.identity.identityAccount);
    expect(identityAddressFromId(fromHex(v.identity.identityId)).toBase58()).toBe(v.identity.identityAccount);
    expect(toHex(sha256(concatBytes([Uint8Array.of(0x21), fromHex(v.identity.publicKey)])))).toBe(v.identity.identityId);
    for (const c of v.burnOnly.cases) expect(identityAddress(fromHex(c.publicKey)).toBase58()).toBe(identityAddressFromId(fromHex(c.identityId)).toBase58());
    expect(() => identityAddressFromId(new Uint8Array(32))).toThrow(/all-zero/);
    expect(() => identityAddress(new Uint8Array(55))).toThrow(/56 bytes/);
  });
});

describe("account bytes", () => {
  it("Launch v2: pq_identity last, creator / params_hash / pq_identity at the documented offsets", () => {
    const acc = v.accounts.launch;
    const data = fromHex(acc.data);
    expect(data.length).toBe(P.launchAccountLen);
    const l = decodeLaunch(pk(acc.address), data);
    expect(l.status).toBe("configured");
    expect(l.version).toBe(2);
    expect(l.creator.toBase58()).toBe(v.attestation.creator);
    expect(toHex(l.paramsHash)).toBe(v.attestation.paramsHash);
    expect(toHex(l.pqIdentity)).toBe(v.identity.identityId);
    expect(toHex(l.launchSeed)).toBe(v.attestation.launchSeed);
    const o = P.launchOffsets;
    expect(toHex(data.subarray(o.creator, o.creator + 32))).toBe(toHex(l.creator.toBytes()));
    expect(toHex(data.subarray(o.paramsHash, o.paramsHash + 32))).toBe(toHex(l.paramsHash));
    expect(toHex(data.subarray(o.pqIdentity, o.pqIdentity + 32))).toBe(toHex(l.pqIdentity));
    expect(data[o.status]).toBe(0); // Configured
    expect(launchAddress(l.creator, l.launchSeed).toBase58()).toBe(acc.address);
  });

  it("Identity: key at 10..66, bitmap LSB first at 66..194, used_count at 194..196", () => {
    const acc = v.accounts.identity;
    const data = fromHex(acc.data);
    expect(data.length).toBe(PQ_IDENTITY.IDENTITY_ACCOUNT_LEN);
    const id = decodeIdentity(pk(acc.address), data);
    expect(toHex(id.lmsPublicKey)).toBe(v.identity.publicKey);
    expect(toHex(id.identityId)).toBe(v.identity.identityId);
    expect(toHex(data.subarray(10, 66))).toBe(v.identity.publicKey);
    expect(id.usedCount).toBe(acc.usedLeaves.length);
    expect(new DataView(data.buffer, data.byteOffset).getUint16(194, true)).toBe(acc.usedLeaves.length);
    for (let q = 0; q < PQ_IDENTITY.LEAVES; q++) {
      const used = acc.usedLeaves.includes(q);
      expect(identityLeafUsed(id, q), `leaf ${q}`).toBe(used);
      expect(((data[66 + (q >> 3)] ?? 0) & (1 << (q & 7))) !== 0).toBe(used);
    }
    expect(() => identityLeafUsed(id, PQ_IDENTITY.LEAVES)).toThrow(/leaf/);
    // Not at the PDA of its own key, or a count that disagrees with the bitmap: refused.
    expect(() => decodeIdentity(pk(v.accounts.attestation.address), data)).toThrow(/PDA/);
    const miscounted = Uint8Array.from(data);
    miscounted[194] = (miscounted[194]! + 1) & 0xff;
    expect(() => decodeIdentity(pk(acc.address), miscounted)).toThrow(/bitmap/);
  });

  it("Attestation (2,708 B, version 3) at the documented offsets; an empty one is version 0", () => {
    const acc = v.accounts.attestation;
    const data = fromHex(acc.data);
    expect(data.length).toBe(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN);
    const a = decodeAttestation(pk(acc.address), data);
    expect(a.attested).toBe(true);
    expect([a.version, a.bump, a.leaf, a.slot]).toEqual([3, acc.bump, acc.leaf, BigInt(acc.slot)]);
    expect(toHex(a.rulesHash)).toBe("00".repeat(32)); // the vector launch has no creator rules
    expect(a.launch.toBase58()).toBe(v.attestation.launch);
    expect(toHex(a.pqIdentity)).toBe(v.identity.identityId);
    expect(toHex(a.metadataHash)).toBe(v.attestation.metadataHash);
    expect(toHex(a.messageHash)).toBe(v.attestation.messageHash);
    expect(toHex(sha256(fromHex(v.attestation.message)))).toBe(v.attestation.messageHash);
    expect([a.notBefore, a.notAfter]).toEqual([BigInt(v.attestation.notBefore), BigInt(v.attestation.notAfter)]);
    expect(toHex(a.signature)).toBe(v.signatures.find((s) => s.q === acc.leaf)!.signature);
    const o = P.attestationOffsets;
    const at = (off: number, len: number): string => toHex(data.subarray(off, off + len));
    expect(at(o.launch, 32)).toBe(toHex(a.launch.toBytes()));
    expect(at(o.pqIdentity, 32)).toBe(toHex(a.pqIdentity));
    expect(new DataView(data.buffer, data.byteOffset).getUint16(o.leaf, true)).toBe(a.leaf);
    expect(at(o.metadataHash, 32)).toBe(toHex(a.metadataHash));
    expect(at(o.rulesHash, 32)).toBe(toHex(a.rulesHash));
    expect(o.rulesHash).toBe(PQ_IDENTITY.ATTESTATION_OFFSETS.RULES_HASH);
    expect(at(o.messageHash, 32)).toBe(toHex(a.messageHash));
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(o.slot, true)).toBe(a.slot);
    expect(new DataView(data.buffer, data.byteOffset).getBigInt64(o.notBefore, true)).toBe(a.notBefore);
    expect(new DataView(data.buffer, data.byteOffset).getBigInt64(o.notAfter, true)).toBe(a.notAfter);
    expect(new DataView(data.buffer, data.byteOffset).getUint32(o.signatureLen, true)).toBe(PQ_IDENTITY.SIGNATURE_LEN);
    expect(o.signature + PQ_IDENTITY.SIGNATURE_LEN).toBe(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN);
    // An attested account must sit at its launch's attestation PDA.
    expect(() => decodeAttestation(pk(v.identity.identityAccount), data)).toThrow(/PDA/);

    const empty = decodeAttestation(pk(acc.address), fromHex(v.burnOnly.emptyAttestation));
    expect(empty.attested).toBe(false);
    expect(empty.version).toBe(0);
    expect(empty.bump).toBe(acc.bump);
    expect(empty.launch.equals(PublicKey.default)).toBe(true);
    expect(empty.signature.length).toBe(0);
  });

  it("events: LaunchAttested and PqLeafConsumed payloads", () => {
    const codec = idlCodecs().launchpad;
    const attested = codec.decodeType<{ launch: PublicKey; pqIdentity: Uint8Array; leaf: number; metadataHash: Uint8Array; slot: bigint; notBefore: bigint; notAfter: bigint }>(
      "LaunchAttested",
      fromHex(v.events.launchAttested.data),
    );
    expect(attested.launch.toBase58()).toBe(v.attestation.launch);
    expect(toHex(attested.pqIdentity)).toBe(v.identity.identityId);
    expect([attested.leaf, attested.slot]).toEqual([v.events.launchAttested.leaf, BigInt(v.events.launchAttested.slot)]);
    expect(toHex(attested.metadataHash)).toBe(v.attestation.metadataHash);
    expect(toHex(codec.encodeType("LaunchAttested", attested))).toBe(v.events.launchAttested.data);
    expect([attested.notBefore, attested.notAfter]).toEqual([BigInt(v.attestation.notBefore), BigInt(v.attestation.notAfter)]);
    const consumed = codec.decodeType<{ pqIdentity: Uint8Array; leaf: number; launch: PublicKey }>("PqLeafConsumed", fromHex(v.events.pqLeafConsumed.data));
    expect(consumed.leaf).toBe(v.events.pqLeafConsumed.leaf);
    expect(consumed.launch.toBase58()).toBe(v.attestation.launch);
    expect(toHex(codec.encodeType("PqLeafConsumed", consumed))).toBe(v.events.pqLeafConsumed.data);
  });
});

describe("metadata and window rules", () => {
  it("metadata_hash_v2 = SHA256(\"PHX-META-V2\" || borsh(name) || borsh(symbol) || flags || borsh(uri) || borsh(doc)), naming the record's address", () => {
    const m = v.metadata;
    const borsh = concatBytes([...[m.name, m.symbol].flatMap((s) => [u32le(utf8(s).length), utf8(s)]), Uint8Array.of(m.flags), ...[m.uri, m.doc].flatMap((s) => [u32le(utf8(s).length), utf8(s)])]);
    expect(toHex(borsh)).toBe(m.borsh);
    expect(toHex(tokenMetaBorsh(m))).toBe(m.borsh);
    expect(toHex(metadataHashV2(m))).toBe(m.hash);
    expect(toHex(sha256(concatBytes([utf8("PHX-META-V2"), borsh])))).toBe(m.hash);
    expect(m.hash).toBe(v.attestation.metadataHash);
    expect(tokenMetaAddress(pk(v.attestation.launch), fromHex(m.hash)).toBase58()).toBe(m.tokenMetaAccount);
    expect(m.tokenMetaAccount).toBe(v.accounts.tokenMeta.address);
    // Every burn-only case's hash and record address, over its raw bytes (even the one that is not UTF-8).
    for (const c of v.burnOnly.cases) {
      expect(toHex(metadataHashV2(bytesOf(c.metadata))), c.name).toBe(c.metadataHash);
      expect(tokenMetaAddress(pk(v.attestation.launch), fromHex(c.metadataHash)).toBase58(), c.name).toBe(c.tokenMetaAccount);
    }
    // Bytes, not UTF-16 units: a one-character change in a multi-byte name changes the hash; so do the flags.
    expect(toHex(metadataHashV2({ name: "€", symbol: "S" }))).not.toBe(toHex(metadataHashV2({ name: "E", symbol: "S" })));
    expect(toHex(metadataHashV2({ name: "N", symbol: "S", flags: 1, doc: "{}" }))).not.toBe(toHex(metadataHashV2({ name: "N", symbol: "S", doc: "{}" })));
  });

  it("record limits are UTF-8 bytes (metadataLimits.examples)", () => {
    for (const e of P.metadataLimits.examples) {
      const b = bytesOf(e.metadata);
      expect([b.name.length, b.symbol.length], e.name).toEqual([e.nameBytes, e.symbolBytes]);
      expect(utf8Length(e.metadata.name), e.name).toBe(e.nameBytes);
      expect(validateTokenMeta({ name: e.metadata.name, symbol: e.metadata.symbol, flags: e.metadata.flags, uri: e.metadata.uri, doc: e.metadata.doc }).ok, e.name).toBe(e.valid);
      expect(validateTokenMeta(b).ok, e.name).toBe(e.valid);
    }
    // A lone surrogate has no UTF-8 encoding: refused instead of signing U+FFFD.
    expect(validateTokenMeta({ name: "ab\uD800", symbol: "S" }).ok).toBe(false);
    expect(validateTokenMeta({ name: "\uDC00", symbol: "S" }).errors.join()).toMatch(/unpaired UTF-16 surrogate/);
    expect(validateTokenMeta({ name: "🚀", symbol: "S" }).ok).toBe(true);
  });

  it("the window rule; every burn-only case lands without attesting, for its own reason", () => {
    const landsAt = BigInt(v.burnOnly.landsAt);
    const a = v.attestation;
    expect(BigInt(a.landsAt)).toBe(landsAt);
    expect(launchWindowIsValid(landsAt, BigInt(a.notBefore), BigInt(a.notAfter))).toBe(true);
    expect(inLaunchWindow(BigInt(a.notBefore), BigInt(a.notBefore), BigInt(a.notAfter))).toBe(true);
    expect(inLaunchWindow(BigInt(a.notAfter), BigInt(a.notBefore), BigInt(a.notAfter))).toBe(true);
    expect(inLaunchWindow(BigInt(a.notAfter) + 1n, BigInt(a.notBefore), BigInt(a.notAfter))).toBe(false);
    expect(inLaunchWindow(BigInt(a.notBefore) - 1n, BigInt(a.notBefore), BigInt(a.notAfter))).toBe(false);
    // Boundaries of pq::launch_window_is_valid.
    const ok = (nb: bigint, na: bigint, now = landsAt): boolean => launchWindowIsValid(now, nb, na);
    expect(ok(landsAt, landsAt + 60n)).toBe(true);
    expect(ok(landsAt, landsAt + 59n)).toBe(false);
    expect(ok(landsAt, landsAt + 3_600n)).toBe(true);
    expect(ok(landsAt, landsAt + 3_601n)).toBe(false);
    expect(ok(landsAt - 3_600n, landsAt)).toBe(false); // ends exactly when it lands: nothing left (audit round 3 F1)
    expect(ok(landsAt - 3_540n, landsAt + 60n)).toBe(true); // exactly 60 s left
    expect(ok(landsAt - 3_541n, landsAt + 59n)).toBe(false);
    expect(ok(landsAt - 3_601n, landsAt - 1n)).toBe(false);
    expect(ok(landsAt + 604_800n, landsAt + 604_860n)).toBe(true);
    expect(ok(landsAt + 604_801n, landsAt + 604_861n)).toBe(false);
    expect(ok(landsAt + 60n, landsAt)).toBe(false); // swapped
    expect(launchWindowProblems(landsAt, landsAt * 1000n, landsAt * 1000n + 3_600_000n).join()).toMatch(/milliseconds/);
    expect(launchWindowProblems(landsAt, 1n << 63n, 0n)).toEqual(["times must be i64 unix seconds (bigint)"]);

    const identityId = v.identity.identityId;
    // The one record published under the vector launch is the vector record.
    const published = v.metadata.tokenMetaAccount;
    for (const c of v.burnOnly.cases) {
      const recordOk = c.tokenMetaAccount === published;
      const windowOk = launchWindowIsValid(landsAt, BigInt(c.terms.notBefore), BigInt(c.terms.notAfter));
      const identityOk = c.identityId === identityId;
      // No rules were published under the vector launch: only the zero rules hash (no rules account) attests.
      const noRules = /^0+$/.test(c.terms.rulesHash);
      expect(c.rulesAccount, c.name).toBe((rulesAccountFor(pk(v.attestation.launch), fromHex(c.terms.rulesHash)) ?? PROGRAM_IDS.launchpad).toBase58());
      expect(recordOk && windowOk && identityOk && noRules, c.name).toBe(false);
      // Exactly one reason per case; a record that could never be published is never the published one.
      expect([recordOk, windowOk, identityOk, noRules].filter((x) => !x).length, c.name).toBe(1);
      if (!validateTokenMeta(bytesOf(c.metadata)).ok) expect(recordOk, c.name).toBe(false);
    }
  });

  it("one canonical export each for the window, the clock and the metadata hash; every time is bigint unix seconds (SDK v2 follow-up)", () => {
    // The retired message-v1 hash is gone from the root; the v2 record hash is the one export.
    expect("launchMetadataHash" in sdk).toBe(false);
    expect(typeof sdk.metadataHashV2).toBe("function");
    // The pqIdentity duplicates are gone; the package root exports one of each.
    for (const n of ["launchWindowIsValid", "defaultLaunchWindow", "metadataHash", "validateLaunchWindow", "unixNowSecs", "DEFAULT_LANDING_MARGIN_SECS"]) {
      expect(n in sdk.pqIdentity, `pqIdentity.${n}`).toBe(false);
    }
    const root = sdk as unknown as Record<string, unknown>;
    for (const n of ["launchWindowIsValid", "launchWindowProblems", "inLaunchWindow", "defaultLaunchWindow", "validateLaunchWindow", "unixNowSecs", "clusterUnixTime", "metadataHashV2"]) {
      expect(typeof root[n], n).toBe("function");
    }
    expect(sdk.ATTEST_LANDING_MARGIN_SECS).toBe(300n);
    expect(sdk.pqIdentity.MAX_LAUNCH_WINDOW_SECS).toBe(BigInt(POLICY.MAX_LAUNCH_WINDOW_SECS));

    // The program's predicate (internal, for clocks read from the chain) is exactly pq::launch_window_is_valid over
    // any i64; the exported helpers are exactly it at any plausible nowSecs, and launchWindowProblems is empty exactly
    // when it holds.
    // With audit round 3 F1: at least 60 s left when it lands (`max(now, nb) + 60 <= na`).
    const pq = (now: bigint, nb: bigint, na: bigint): boolean => na - nb >= 60n && na - nb <= 3_600n && (now > nb ? now : nb) + 60n <= na && nb <= now + 604_800n;
    const landsAt = BigInt(v.burnOnly.landsAt);
    const far = 100_000_000_000n; // the old root helper refused any window above this as "milliseconds", valid or not
    for (const now of [0n, landsAt, far - 1n, far, far + 1n, -far, -far + 1n]) {
      const plausible = now < far && now > -far;
      for (const nb of [now - 3_601n, now - 3_600n, now - 3_540n, now - 3_539n, now - 60n, now - 1n, now, now + 1n, now + 604_800n, now + 604_801n, far + 1n, landsAt * 1000n]) {
        for (const len of [59n, 60n, 3_600n, 3_601n, -1n]) {
          const na = nb + len;
          const valid = windowValidAt(now, nb, na);
          expect(valid, `${now} ${nb} ${na}`).toBe(pq(now, nb, na));
          expect(windowProblemsAt(now, nb, na).length === 0, `${now} ${nb} ${na}`).toBe(valid);
          if (plausible) {
            expect(launchWindowIsValid(now, nb, na), `${now} ${nb} ${na}`).toBe(valid);
            expect(launchWindowProblems(now, nb, na).length === 0, `${now} ${nb} ${na}`).toBe(valid);
          } else {
            expect(() => launchWindowIsValid(now, nb, na), `${now}`).toThrow(RangeError);
            expect(() => launchWindowProblems(now, nb, na), `${now}`).toThrow(RangeError);
            expect(() => inLaunchWindow(now, nb, na), `${now}`).toThrow(RangeError);
          }
        }
      }
    }
    expect(windowValidAt(far + 1n, far + 1n, far + 61n)).toBe(true);
    expect(launchWindowIsValid(far - 1n, far - 1n, far + 59n)).toBe(true); // a valid window above 10^11 at a plausible now
    expect(launchWindowProblems(landsAt, landsAt * 1000n, landsAt * 1000n + 60n).join()).toMatch(/milliseconds/);
    expect(launchWindowIsValid(0n, 1n << 63n, (1n << 63n) + 60n)).toBe(false); // outside i64: the program cannot receive it

    // Review finding: every "now" of the window helpers is checked like every other one. A Date.now() "now" with a
    // window in milliseconds used to pass (valid, inside), and a seconds window used to be silently "missed".
    const ms = BigInt(Date.now());
    const s = unixNowSecs();
    expect(() => inLaunchWindow(ms, ms - 10n, ms + 3_590n)).toThrow(/nowSecs looks like milliseconds/);
    expect(() => inLaunchWindow(ms, s - 10n, s + 3_590n)).toThrow(RangeError);
    expect(() => launchWindowIsValid(ms, ms + 10n, ms + 3_610n)).toThrow(/nowSecs looks like milliseconds/);
    expect(() => launchWindowProblems(ms, ms + 10n, ms + 3_610n)).toThrow(RangeError);
    expect(() => validateLaunchWindow(s + 600n, s + 4_200n, { nowSecs: ms })).toThrow(/opts\.nowSecs looks like milliseconds/);
    expect(() => launchWindowProblems(1 as unknown as bigint, 2n, 3n)).toThrow(TypeError);
    expect(() => launchWindowProblems(0n, 2 as unknown as bigint, 3n)).toThrow(TypeError);
    expect(() => inLaunchWindow(0n, 2n, 3 as unknown as bigint)).toThrow(TypeError);
    expect(inLaunchWindow(s, s - 10n, s + 3_590n)).toBe(true);

    // A number is a TypeError everywhere (`1 < 2n` would otherwise compare silently).
    expect(() => launchWindowIsValid(0 as unknown as bigint, 0n, 60n)).toThrow(TypeError);
    expect(() => inLaunchWindow(5 as unknown as bigint, 0n, 60n)).toThrow(TypeError);
    expect(() => defaultLaunchWindow(5 as unknown as bigint)).toThrow(TypeError);
    expect(() => validateLaunchWindow(0n, 60n, { nowSecs: 0 as unknown as bigint })).toThrow(TypeError);
    // The renamed option says so instead of being ignored.
    expect(() => validateLaunchWindow(0n, 60n, { now: 0n } as never)).toThrow(/opts\.now is now opts\.nowSecs/);
    expect(validateLaunchWindow(1_000n, 1_060n, { nowSecs: 0n }).ok).toBe(true);
    expect(defaultLaunchWindow(1_000n)).toEqual({ notBefore: 1_000n, notAfter: 4_600n });
    expect(() => defaultLaunchWindow((1n << 63n) - 1n)).toThrow(RangeError);
    expect(unixNowSecs(1_767_225_600_999)).toBe(1_767_225_600n);
    // The one metadata hash takes text or bytes, nothing else.
    expect(toHex(metadataHashV2({ name: "A", symbol: "B", uri: "c" }))).toBe(toHex(metadataHashV2({ name: utf8("A"), symbol: utf8("B"), uri: utf8("c") })));
    expect(() => metadataHashV2({ name: 5 as unknown as string, symbol: "S" })).toThrow(TypeError);
    expect(() => metadataHashV2({ name: "N", symbol: "S", flags: 256 })).toThrow(RangeError);
  });
});

describe("attest_launch instruction (IDL-encoded)", () => {
  it("data and accounts equal the Rust vector", () => {
    const sig = v.signatures.find((s) => s.q === v.attestLaunch.q)!;
    const launch = pk(v.attestation.launch);
    const payer = pk(v.attestLaunch.payer);
    const ix = buildInstruction(
      idlCodecs().launchpad,
      PROGRAM_IDS.launchpad,
      "attest_launch",
      { payer, launch, identity: identityAddress(fromHex(v.identity.publicKey)), attestation: attestationAddress(launch), tokenMeta: tokenMetaAddress(launch, fromHex(v.attestation.metadataHash)), rules: null },
      {
        lmsPk: fromHex(v.identity.publicKey),
        lmsSig: fromHex(sig.signature),
        metadataHash: fromHex(v.attestation.metadataHash),
        rulesHash: new Uint8Array(32),
        notBefore: BigInt(v.attestation.notBefore),
        notAfter: BigInt(v.attestation.notAfter),
      },
    );
    expect(toHex(ix.data)).toBe(v.attestLaunch.data);
    expect(ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toEqual(v.attestLaunch.accounts);
    // P1c: 7 accounts, the last the launchpad program id in place of the rules record (zero rules hash).
    expect(v.attestLaunch.accounts).toHaveLength(7);
    expect(v.attestLaunch.accounts[6]).toEqual({ pubkey: PROGRAM_IDS.launchpad.toBase58(), isSigner: false, isWritable: false });
    // The SDK's builder gives the same instruction.
    const sdkIx = attestLaunchInstruction({ payer, launch, lmsPublicKey: fromHex(v.identity.publicKey), lmsSignature: fromHex(sig.signature), metadataHash: fromHex(v.attestation.metadataHash), notBefore: BigInt(v.attestation.notBefore), notAfter: BigInt(v.attestation.notAfter) });
    expect(toHex(sdkIx.data)).toBe(v.attestLaunch.data);
    expect(sdkIx.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toEqual(v.attestLaunch.accounts);
  });
});

describe("PQ vault recognition (pq::is_vault_of)", () => {
  it("vault program, Vault discriminator, version 4 at byte 8, the mint at 10..42; nothing else", () => {
    const mint = new PublicKey(new Uint8Array(32).fill(7));
    const other = new PublicKey(new Uint8Array(32).fill(8));
    const data = concatBytes([idlCodecs().vault.accountDiscriminator("Vault"), Uint8Array.of(4, 255), mint.toBytes(), new Uint8Array(174 - 42)]);
    expect(data.length).toBe(idlCodecs().vault.accountSize("Vault"));
    const acc = { owner: PROGRAM_IDS.vault, data };
    expect(isPqVaultOf(acc, mint)).toBe(true);
    expect(pqVaultMint(acc)?.equals(mint)).toBe(true);
    expect(isPqVaultOf(acc, other)).toBe(false);
    expect(isPqVaultOf({ ...acc, owner: PROGRAM_IDS.launchpad }, mint)).toBe(false);
    const v3 = Uint8Array.from(data);
    v3[8] = 3;
    expect(isPqVaultOf({ ...acc, data: v3 }, mint)).toBe(false);
    expect(pqVaultMint({ ...acc, data: v3 })).toBeNull();
    const payout = concatBytes([idlCodecs().vault.accountDiscriminator("Payout"), data.subarray(8)]);
    expect(isPqVaultOf({ ...acc, data: payout }, mint)).toBe(false);
    expect(isPqVaultOf({ ...acc, data: data.subarray(0, 41) }, mint)).toBe(false);
    expect(isPqVaultOf(null, mint)).toBe(false);
  });
});

/**
 * Rust-generated (test/vectors/launchpad_rust.json, printed by a scratch
 * binary built against the noised-launchpad crate itself: `AnchorSerialize`
 * of `LaunchParams`, `policy::validate`, `pq::metadata_hash` and
 * `Pubkey::find_program_address` with the crate's seed constants).
 */
describe("launchpad crate vectors (borsh LaunchParams, params_hash, PDAs)", () => {
  interface RustVectors {
    params: { name: string; borsh: string; paramsHash: string; valid: boolean }[];
    pdas: Record<"creator" | "launchSeed" | "launch" | "vault" | "payoutVault" | "attestation" | "identityId" | "identity", string>;
  }
  const r = readJson<RustVectors>("./vectors/launchpad_rust.json");

  it("serializeLaunchParams / launchParamsHash / validateLaunchParams agree with the crate", () => {
    expect(r.params.length).toBe(2);
    for (const c of r.params) {
      const p = deserializeLaunchParams(fromHex(c.borsh));
      expect(toHex(serializeLaunchParams(p)), c.name).toBe(c.borsh);
      expect(toHex(launchParamsHash(p)), c.name).toBe(c.paramsHash);
      expect(p.pqIdentity.length).toBe(32);
      const v = validateLaunchParams(p);
      expect(v.ok, `${c.name}: ${v.errors.join("; ")}`).toBe(c.valid);
    }
    const max = deserializeLaunchParams(fromHex(r.params[1]!.borsh));
    expect([max.curve.length, max.recipients.length, max.dynamicFee !== null]).toEqual([POLICY.MAX_CURVE_POINTS, POLICY.MAX_RECIPIENTS, true]);
  });

  // Its `metadata` section holds the retired message-v1 hashes (pq::metadata_hash, no longer in the program);
  // metadata_hash_v2 is pinned by vectors/metadata.json and vectors/lms.json (test/metadata.test.ts).

  it("launch, payout-vault, attestation and identity PDAs agree with the crate's seeds", () => {
    const d = r.pdas;
    const launch = launchAddress(pk(d.creator), fromHex(d.launchSeed));
    expect(launch.toBase58()).toBe(d.launch);
    expect(payoutVaultAddress(launch, pk(d.vault)).toBase58()).toBe(d.payoutVault);
    expect(attestationAddress(launch).toBase58()).toBe(d.attestation);
    expect(identityAddressFromId(fromHex(d.identityId)).toBase58()).toBe(d.identity);
  });
});

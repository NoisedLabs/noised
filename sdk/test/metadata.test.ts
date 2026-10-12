/**
 * The on-chain metadata record (`src/metadata/record.ts`, `publish.ts`)
 * byte for byte against `vectors/metadata.json` (a copy of
 * tests/integration/vectors/metadata.json, written by
 * tests/integration/tests/metadata_vectors.rs, recomputed by the independent
 * Python reference and published on the launchpad build by
 * vectors_onchain.rs):
 *
 * - every record: borsh, `metadata_hash_v2`, address and bump under the
 *   `lms.json` launch, account bytes and space, the uri `launch` derives,
 *   `publish_metadata`'s data and the `MetadataPublished` payload;
 * - every invalid record: the program's error, in its order of checks;
 * - the typical record's `publish_metadata` instruction, its attestation
 *   (message v2, data, the six accounts) and `launch`'s data and 22 accounts;
 * - decoding refuses what `publish_metadata` never writes; records are read
 *   only through an attestation or a certificate;
 * - building, funding and sending `publish_metadata` against a model of the
 *   program (`./attest_world.ts`), and the throwaway payer's funding.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { CERTIFICATE, CERTIFICATE_RULES_BOUND, METADATA, POLICY, PQ_IDENTITY, PROGRAM_IDS, SEEDS } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { buildLaunchTx } from "../src/launch/builders.js";
import {
  buildFundThrowawayPayerTx,
  buildPublishMetadataTx,
  publishFeeLamports,
  publishMetadataData,
  publishMetadataInstruction,
  publishTransactionSize,
  publishTxConfig,
  PUBLISH_COMPUTE_UNITS,
  PublishPayerFundingError,
  sendPublishMetadataTx,
  throwawayPayerFunding,
  waitForTokenMeta,
  type PublishMetadataReady,
} from "../src/metadata/publish.js";
import {
  decodeMetadataPublishedEvent,
  decodeTokenMeta,
  externalUriIsValid,
  fetchTokenMeta,
  fetchTokenMetaForLaunch,
  fetchTokenMetaForMint,
  launchedMintSpace,
  metadataHashV2,
  tokenMetaAccountData,
  tokenMetaBorsh,
  tokenMetaRecord,
  tokenMetaSpace,
  tokenUri,
  tokenUriBytes,
  validateTokenMeta,
  type TokenMetaRecord,
} from "../src/metadata/record.js";
import { attestationAddress, certificateAddress, launchPdasFromLaunch, tokenMetaAddress, tokenMetaPda } from "../src/pda.js";
import { attestLaunchInstruction } from "../src/pq/attest.js";
import { attestationMessage, leafProbeStart, nextFreeLeaf } from "../src/pq/identity.js";
import { lmsVerify } from "../src/pq/lms.js";
import { decodeV1Transaction } from "../src/tx/v1.js";
import { AttestConnection, attestationAccountBytes, emulatedMetadataError, emulatedTokenMetaBytes, emulatePublishMetadata } from "./attest_world.js";
import { key, readJson } from "./helpers.js";
import { accountBytes, clock } from "./world.js";

interface RecordJson {
  name: string | null;
  nameHex: string;
  symbol: string | null;
  symbolHex: string;
  flags: number;
  uri: string | null;
  uriHex: string;
  doc: string | null;
  docHex: string;
}
interface MetadataVectors {
  parameters: {
    attestMessageLen: number;
    attestMessageTag: string;
    certificate: { accountLen: number; allChecks: number; metadataOffset: number; metadataOnchainCheck: number; safetyPolicyVersion: number; version: number };
    discriminators: Record<"attestLaunch" | "certificate" | "launch" | "metadataPublished" | "publishMetadata" | "tokenMeta", string>;
    errors: { name: string; number: number }[];
    externalUriPrefix: string;
    flags: { externalUri: number; inlineUri: number; none: number };
    inlineUriPrefix: string;
    launchpad: string;
    maxDocLen: number;
    maxInlineUriLen: number;
    maxNameLen: number;
    maxSymbolLen: number;
    maxUriLen: number;
    metadataHashTag: string;
    metadataSeed: string;
    tokenMetaFixedLen: number;
    tokenMetaOffsets: Record<"bump" | "flags" | "launch" | "metadataHash" | "name" | "version", number>;
    tokenMetaVersion: number;
  };
  launch: { address: string; creator: string; launchBytes: string; launchSeed: string };
  cases: {
    name: string;
    record: RecordJson;
    borsh: string;
    metadataHash: string;
    tokenMeta: { address: string; bump: number; data: string; space: number };
    tokenUri: string;
    tokenUriLen: number;
    publishData: string;
    metadataPublishedEvent: string;
  }[];
  invalid: { name: string; record: RecordJson; error: string; errorNumber: number; publishData: string }[];
  pdas: { name: string; launch: string; metadataHash: string; address: string; bump: number }[];
  publishTypical: { payer: string; payerSeed: string; data: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
  attestation: {
    record: string;
    launch: string;
    paramsHash: string;
    creatorBytes: string;
    metadataHash: string;
    notBefore: number;
    notAfter: number;
    message: string;
    messageHash: string;
    publicKey: string;
    q: number;
    signature: string;
    data: string;
    payer: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    identityAccount: string;
    attestationAccount: string;
    tokenMetaAccount: string;
  };
  launchInstruction: { data: string; accounts: { name: string; isSigner: boolean; isWritable: boolean }[]; attestationAccount: string; tokenMetaAccount: string };
}

const v = readJson<MetadataVectors>("./vectors/metadata.json");
const lms = readJson<{ accounts: { launch: { data: string } }; attestation: { landsAt: number } }>("./vectors/lms.json");
const LAUNCH = new PublicKey(v.launch.address);
const recordOf = (r: RecordJson): TokenMetaRecord => ({ name: fromHex(r.nameHex), symbol: fromHex(r.symbolHex), flags: r.flags, uri: fromHex(r.uriHex), doc: fromHex(r.docHex) });
const TYPICAL = v.cases[1]!;
const typical = recordOf(TYPICAL.record);

/** The `lms.json` launch (Configured), at the vectors' landing time; `launch` reads its PDAs, so they are the real ones here. */
function vectorLaunch(): AttestConnection {
  const conn = new AttestConnection();
  const codec = idlCodecs().launchpad;
  const raw = codec.decodeAccount<Record<string, unknown>>("Launch", fromHex(lms.accounts.launch.data));
  const p = launchPdasFromLaunch(LAUNCH);
  const data = accountBytes("launchpad", "Launch", { ...raw, launchAuthority: p.launchAuthority, batchAuthority: p.batchAuthority, dbcConfig: p.dbcConfig });
  conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data });
  conn.setClock(BigInt(lms.attestation.landsAt));
  conn.land = (w) => emulatePublishMetadata(conn, w);
  return conn;
}

describe("constants equal the vectors' parameters", () => {
  it("seeds, limits, flags, prefixes, offsets, versions, discriminators and errors", () => {
    const P = v.parameters;
    expect(P.launchpad).toBe(PROGRAM_IDS.launchpad.toBase58());
    expect([P.metadataSeed, P.metadataHashTag, P.inlineUriPrefix, P.externalUriPrefix]).toEqual([SEEDS.metadata, METADATA.HASH_TAG, METADATA.INLINE_URI_PREFIX, METADATA.EXTERNAL_URI_PREFIX]);
    expect([P.maxNameLen, P.maxSymbolLen, P.maxUriLen, P.maxDocLen, P.maxInlineUriLen]).toEqual([METADATA.MAX_NAME_LEN, METADATA.MAX_SYMBOL_LEN, METADATA.MAX_URI_LEN, METADATA.MAX_DOC_LEN, METADATA.MAX_INLINE_URI_LEN]);
    expect(P.flags).toEqual({ none: 0, inlineUri: METADATA.FLAG_INLINE_URI, externalUri: METADATA.FLAG_EXTERNAL_URI });
    expect([P.tokenMetaFixedLen, P.tokenMetaVersion]).toEqual([METADATA.TOKEN_META_FIXED_LEN, METADATA.TOKEN_META_VERSION]);
    const o = METADATA.TOKEN_META_OFFSETS;
    expect(P.tokenMetaOffsets).toEqual({ version: o.VERSION, bump: o.BUMP, flags: o.FLAGS, launch: o.LAUNCH, metadataHash: o.METADATA_HASH, name: o.NAME });
    expect([P.attestMessageTag, P.attestMessageLen]).toEqual([PQ_IDENTITY.ATTEST_MESSAGE_TAG, PQ_IDENTITY.ATTEST_MESSAGE_LEN]);
    expect(P.certificate).toEqual({
      accountLen: CERTIFICATE.ACCOUNT_LEN,
      allChecks: 4_095,
      metadataOffset: CERTIFICATE.METADATA_OFFSET,
      metadataOnchainCheck: 2_048,
      rulesBoundCheck: CERTIFICATE_RULES_BOUND,
      rulesHashOffset: CERTIFICATE.RULES_HASH_OFFSET,
      safetyPolicyVersion: POLICY.SAFETY_POLICY_VERSION,
      version: CERTIFICATE.VERSION,
    });
    expect(toHex(Uint8Array.from(METADATA.TOKEN_META_DISCRIMINATOR))).toBe(P.discriminators.tokenMeta);
    expect(toHex(publishMetadataData({ name: "a", symbol: "b" }).subarray(0, 8))).toBe(P.discriminators.publishMetadata);
    expect(Object.fromEntries(P.errors.map((e) => [e.name, e.number]))).toEqual(METADATA.ERRORS);
    for (const e of P.errors) expect(idlCodecs().launchpad.errorByCode(e.number)?.name).toBe(e.name);
  });
});

describe("records (vectors: cases)", () => {
  it("borsh, metadata_hash_v2, address and bump, account bytes and space, the derived uri, publish data and event", () => {
    expect(v.cases).toHaveLength(9);
    for (const c of v.cases) {
      const r = recordOf(c.record);
      expect(toHex(tokenMetaBorsh(r)), c.name).toBe(c.borsh);
      const hash = metadataHashV2(r);
      expect(toHex(hash), c.name).toBe(c.metadataHash);
      expect(toHex(sha256(concatBytes([utf8("PHX-META-V2"), fromHex(c.borsh)]))), c.name).toBe(c.metadataHash);
      const [address, bump] = tokenMetaPda(LAUNCH, hash);
      expect([address.toBase58(), bump], c.name).toEqual([c.tokenMeta.address, c.tokenMeta.bump]);
      expect(tokenMetaAddress(LAUNCH, hash).toBase58()).toBe(c.tokenMeta.address);
      expect(toHex(tokenMetaAccountData(LAUNCH, r)), c.name).toBe(c.tokenMeta.data);
      expect(toHex(emulatedTokenMetaBytes(LAUNCH, r.name, r.symbol, r.flags, r.uri, r.doc)), c.name).toBe(c.tokenMeta.data);
      expect(tokenMetaSpace(r), c.name).toBe(c.tokenMeta.space);
      expect(fromHex(c.tokenMeta.data).length).toBe(c.tokenMeta.space);
      expect(tokenUri(r), c.name).toBe(c.tokenUri);
      expect(tokenUriBytes(r).length, c.name).toBe(c.tokenUriLen);
      expect(launchedMintSpace(r)).toBe(METADATA.MINT_BASE_LEN + r.name.length + r.symbol.length + c.tokenUriLen);
      expect(toHex(publishMetadataData(r)), c.name).toBe(c.publishData);
      const ix = publishMetadataInstruction(key("payer"), LAUNCH, r);
      expect(toHex(ix.data), c.name).toBe(c.publishData);
      expect(ix.keys[2]!.pubkey.toBase58()).toBe(c.tokenMeta.address);
      expect(validateTokenMeta(r), c.name).toEqual({ ok: true, error: null, errors: [] });
      expect(emulatedMetadataError(r.name, r.symbol, r.flags, r.uri, r.doc), c.name).toBeNull();
      expect(publishTransactionSize(r), c.name).toBe(307 + r.name.length + r.symbol.length + r.uri.length + r.doc.length);
      // The event the program emits.
      const disc = fromHex(v.parameters.discriminators.metadataPublished);
      const e = decodeMetadataPublishedEvent(concatBytes([disc, fromHex(c.metadataPublishedEvent)]))!;
      expect([e.launch.toBase58(), e.tokenMeta.toBase58(), toHex(e.metadataHash), e.flags, e.uriLen, e.docLen], c.name).toEqual([v.launch.address, c.tokenMeta.address, c.metadataHash, r.flags, r.uri.length, r.doc.length]);
      // The account reads back to the record.
      const acc = decodeTokenMeta(address, fromHex(c.tokenMeta.data));
      expect([acc.version, acc.bump, acc.flags, acc.launch.toBase58(), toHex(acc.metadataHash)], c.name).toEqual([1, c.tokenMeta.bump, r.flags, v.launch.address, c.metadataHash]);
      expect([toHex(acc.record.name), toHex(acc.record.symbol), toHex(acc.record.uri), toHex(acc.doc)], c.name).toEqual([c.record.nameHex, c.record.symbolHex, c.record.uriHex, c.record.docHex]);
      expect([acc.name, acc.symbol, acc.uri, acc.tokenUri], c.name).toEqual([c.record.name, c.record.symbol, c.record.uri, c.tokenUri]);
    }
    // The largest record: 3,405 bytes of account, 3,621 bytes of publish transaction (the measured maximum); the smallest 309.
    const largest = recordOf(v.cases[7]!.record);
    expect(tokenMetaSpace(largest)).toBe(METADATA.MAX_TOKEN_META_LEN);
    expect(publishTransactionSize(largest)).toBe(3_621);
    expect(publishTransactionSize({ name: "N", symbol: "S" })).toBe(309);
    expect(publishTransactionSize(largest, { priorityFee: true })).toBe(3_629);
    // The inline uri of the largest document is the longest uri launch derives.
    expect(tokenUriBytes(recordOf(v.cases[5]!.record)).length).toBe(METADATA.MAX_INLINE_URI_LEN);
    // The multi-byte inline document: base64 with '+', '/' and '==' (RFC 4648, padded), decoding back to the document.
    const multi = v.cases[8]!;
    expect(multi.tokenUri).toMatch(/\+/);
    expect(multi.tokenUri).toMatch(/\//);
    expect(multi.tokenUri.endsWith("==")).toBe(true);
    expect(toHex(Uint8Array.from(atob(multi.tokenUri.slice(METADATA.INLINE_URI_PREFIX.length)), (ch) => ch.charCodeAt(0)))).toBe(multi.record.docHex);
  });

  it("strings and bytes give the same record; types and flags outside u8 are refused before any rule", () => {
    const t = TYPICAL.record;
    const fromText = tokenMetaRecord({ name: t.name!, symbol: t.symbol!, flags: t.flags, uri: t.uri!, doc: t.doc! });
    expect(toHex(tokenMetaBorsh(fromText))).toBe(TYPICAL.borsh);
    expect(tokenMetaRecord({ name: "N", symbol: "S" })).toEqual({ name: utf8("N"), symbol: utf8("S"), flags: 0, uri: new Uint8Array(0), doc: new Uint8Array(0) });
    // A copy: the caller's buffer may change later without changing the record.
    const name = utf8("Name");
    const r = tokenMetaRecord({ name, symbol: "S" });
    name[0] = 0x58;
    expect(toHex(r.name)).toBe(toHex(utf8("Name")));
    expect(() => tokenMetaRecord({ name: 5 as never, symbol: "S" })).toThrow(TypeError);
    expect(() => tokenMetaRecord({ name: "N", symbol: "S", flags: 256 })).toThrow(RangeError);
    expect(() => tokenMetaRecord({ name: "N", symbol: "S", flags: 1.5 })).toThrow(RangeError);
    expect(() => tokenMetaRecord(null as never)).toThrow(TypeError);
    expect(validateTokenMeta({ name: "N", symbol: "S", flags: -1 }).error).toEqual({ code: 6045, name: "InvalidMetadataFlags" });
  });
});

describe("invalid records (vectors: invalid): the program's error, in its order", () => {
  it("validateTokenMeta's first error is the vectors' (and the test's own model of policy::validate_metadata agrees)", () => {
    expect(v.invalid).toHaveLength(19);
    for (const c of v.invalid) {
      const r = recordOf(c.record);
      const got = validateTokenMeta(r);
      expect(got.ok, c.name).toBe(false);
      expect(got.error, c.name).toEqual({ code: c.errorNumber, name: c.error });
      expect(emulatedMetadataError(r.name, r.symbol, r.flags, r.uri, r.doc), c.name).toBe(c.errorNumber);
      expect(toHex(publishMetadataData(r)), c.name).toBe(c.publishData);
    }
  });

  it("every problem is listed, in order; the external uri rule byte by byte", () => {
    // Two faults: flags first, then lengths.
    const both = validateTokenMeta({ name: "", symbol: "S", flags: 3, uri: "u".repeat(201) });
    expect(both.error).toEqual({ code: 6045, name: "InvalidMetadataFlags" });
    expect(both.errors).toEqual([
      "flags: must be 0, 1 (inline uri) or 2 (external uri), at most one uri mode (is 3)",
      "uri: must be at most 200 bytes (is 201)",
      "name: must be 1..=32 bytes of UTF-8 (is 0)",
      "uri: must be empty unless the external-uri flag is set",
    ]);
    expect(validateTokenMeta({ name: "N", symbol: "S", doc: "x".repeat(3_073) }).error).toEqual({ code: 6046, name: "MetadataTooLong" });
    expect(validateTokenMeta({ name: "N", symbol: "S", doc: "x".repeat(3_072) }).ok).toBe(true);
    expect(validateTokenMeta({ name: "N", symbol: "S", flags: 1 }).errors).toEqual(["doc: an inline uri needs a document"]);
    expect(validateTokenMeta({ name: "N", symbol: "S", flags: 1, doc: "x" }).ok).toBe(true);
    const ext = (uri: string | Uint8Array): boolean => validateTokenMeta({ name: "N", symbol: "S", flags: 2, uri }).ok;
    expect([ext("https://a"), ext(`https://${"a".repeat(192)}`), ext(`https://${"!~".repeat(96)}`)]).toEqual([true, true, true]);
    expect([ext("https://"), ext("http://abc"), ext("HTTPS://abc"), ext("//abc"), ext("https://a b"), ext("https://a\tb"), ext("https://é")]).toEqual([false, false, false, false, false, false, false]);
    expect(ext(Uint8Array.of(...utf8("https://a"), 0x7f))).toBe(false);
    expect(ext(Uint8Array.of(...utf8("https://a"), 0x00))).toBe(false);
    expect(externalUriIsValid(`https://${"a".repeat(193)}`)).toBe(false);
    expect(validateTokenMeta({ name: "N", symbol: "S", flags: 2, uri: `https://${"a".repeat(193)}` }).error).toEqual({ code: 6046, name: "MetadataTooLong" });
    // Text that is not UTF-8 never reaches the rules: the program could not even decode the instruction.
    expect(validateTokenMeta({ name: Uint8Array.of(0xff), symbol: "S" }).error).toEqual({ code: 102, name: "InstructionDidNotDeserialize" });
    expect(validateTokenMeta({ name: "N", symbol: "S", doc: Uint8Array.of(0xc0, 0xaf) }).errors).toEqual(["doc: is not valid UTF-8"]);
  });
});

describe("addresses (vectors: pdas), and the typical record's instructions", () => {
  it("record addresses for other launches and hashes", () => {
    for (const p of v.pdas) {
      const [address, bump] = tokenMetaPda(new PublicKey(p.launch), fromHex(p.metadataHash));
      expect([address.toBase58(), bump], p.name).toEqual([p.address, p.bump]);
    }
    expect(() => tokenMetaAddress(LAUNCH, new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => tokenMetaAddress("x" as never, new Uint8Array(32))).toThrow(/PublicKey/);
  });

  it("publish_metadata of the typical record: the payer, the launch, the record (writable), the System program", () => {
    const payer = Keypair.fromSeed(fromHex(v.publishTypical.payerSeed));
    expect(payer.publicKey.toBase58()).toBe(v.publishTypical.payer);
    const ix = publishMetadataInstruction(payer.publicKey, LAUNCH, typical);
    expect(toHex(ix.data)).toBe(v.publishTypical.data);
    expect(ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toEqual(v.publishTypical.accounts);
    expect(() => publishMetadataInstruction(payer.publicKey, LAUNCH, { ...typical, name: Uint8Array.of(0xff) })).toThrow(/not valid UTF-8/);
    // A leading BOM is kept, byte for byte (a decoder that drops it would change the hash).
    const bom = { name: "﻿BOM", symbol: "S" };
    expect(toHex(publishMetadataInstruction(payer.publicKey, LAUNCH, bom).data.subarray(8))).toBe(toHex(tokenMetaBorsh(bom)));
  });

  it("its attestation: message v2, the identity's signature at the leaf the message probes to, attest_launch's data and six accounts", () => {
    const a = v.attestation;
    expect(a.record).toBe(TYPICAL.name);
    expect(a.metadataHash).toBe(TYPICAL.metadataHash);
    const message = attestationMessage({ launch: LAUNCH, paramsHash: fromHex(a.paramsHash), creator: new PublicKey(fromHex(a.creatorBytes)), metadataHash: fromHex(a.metadataHash), notBefore: BigInt(a.notBefore), notAfter: BigInt(a.notAfter) });
    expect(toHex(message)).toBe(a.message);
    expect(toHex(sha256(message))).toBe(a.messageHash);
    const pk = fromHex(a.publicKey);
    expect(lmsVerify(pk, message, fromHex(a.signature))).toBe(a.q);
    // The vectors pin the retired v1 probe (public); the SDK now starts at the secret probe v2 (audit 4, ID-F1a).
    expect(nextFreeLeaf(new Uint8Array(128), leafProbeStart(pk.subarray(8, 24), message))).toBe(a.q);
    const ix = attestLaunchInstruction({ payer: new PublicKey(a.payer), launch: LAUNCH, lmsPublicKey: pk, lmsSignature: fromHex(a.signature), metadataHash: fromHex(a.metadataHash), notBefore: BigInt(a.notBefore), notAfter: BigInt(a.notAfter) });
    expect(toHex(ix.data)).toBe(a.data);
    expect(ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toEqual(a.accounts);
    expect([ix.keys[2]!.pubkey.toBase58(), ix.keys[3]!.pubkey.toBase58(), ix.keys[4]!.pubkey.toBase58()]).toEqual([a.identityAccount, a.attestationAccount, a.tokenMetaAccount]);
    expect(a.tokenMetaAccount).toBe(TYPICAL.tokenMeta.address);
  });

  it("launch: the discriminator alone and the 23 accounts, the attestation, the record it names, then the rules account (the program id: no rules) last", async () => {
    const L = v.launchInstruction;
    const conn = vectorLaunch();
    const now = BigInt(lms.attestation.landsAt);
    conn.set(attestationAddress(LAUNCH), {
      owner: PROGRAM_IDS.launchpad,
      data: attestationAccountBytes({
        version: 3,
        bump: 255,
        launch: LAUNCH,
        pqIdentity: fromHex("bc0127aba7c34b308ec1790388faa7cf2b58cc3ce2ed3e4b8875678b69096942"),
        leaf: v.attestation.q,
        metadataHash: fromHex(TYPICAL.metadataHash),
        messageHash: fromHex(v.attestation.messageHash),
        slot: 1n,
        notBefore: now,
        notAfter: now + 3_600n,
        signature: fromHex(v.attestation.signature),
      }),
    });
    conn.set(new PublicKey(TYPICAL.tokenMeta.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(TYPICAL.tokenMeta.data) });
    const payer = new PublicKey(v.attestation.payer);
    const { tx } = await buildLaunchTx(conn.asConnection(), payer, LAUNCH, Keypair.generate());
    const ix = tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.launchpad))!;
    expect(toHex(ix.data)).toBe(L.data);
    const names = idlCodecs().launchpad.instruction("launch").accounts.map((a) => a.name);
    expect(ix.keys.map((k, i) => ({ isSigner: k.isSigner, isWritable: k.isWritable, name: names[i] }))).toEqual(L.accounts);
    expect(ix.keys[20]!.pubkey.toBase58()).toBe(L.attestationAccount);
    expect(ix.keys[21]!.pubkey.toBase58()).toBe(L.tokenMetaAccount);
    expect(L.tokenMetaAccount).toBe(TYPICAL.tokenMeta.address);
    expect(ix.keys).toHaveLength(23);
    expect(ix.keys[22]!.pubkey.equals(PROGRAM_IDS.launchpad)).toBe(true);
  });
});

describe("decodeTokenMeta refuses what publish_metadata never writes", () => {
  const address = new PublicKey(TYPICAL.tokenMeta.address);
  const data = (): Uint8Array => fromHex(TYPICAL.tokenMeta.data);

  it("another discriminator or version, a byte too few or too many, a stored hash or bump that is not its own, text that is not UTF-8", () => {
    expect(decodeTokenMeta(address, data()).name).toBe("Phalanx Cryo Token");
    const patched = (f: (d: Uint8Array) => Uint8Array | void): Uint8Array => {
      const d = data();
      return f(d) ?? d;
    };
    expect(() => decodeTokenMeta(address, patched((d) => void (d[0]! ^= 1)))).toThrow(/discriminator/);
    expect(() => decodeTokenMeta(address, patched((d) => void (d[8] = 0)))).toThrow(/version 0/);
    expect(() => decodeTokenMeta(address, patched((d) => void (d[8] = 2)))).toThrow(/version 2/);
    expect(() => decodeTokenMeta(address, patched((d) => concatBytes([d, Uint8Array.of(0)])))).toThrow(/bytes after its document/);
    expect(() => decodeTokenMeta(address, patched((d) => d.subarray(0, d.length - 1)))).toThrow(/truncated/);
    expect(() => decodeTokenMeta(address, patched((d) => d.subarray(0, 90)))).toThrow(/at least 91 bytes/);
    expect(() => decodeTokenMeta(address, patched((d) => void (d[d.length - 3]! ^= 1)))).toThrow(/not the hash of its content/);
    expect(() => decodeTokenMeta(address, patched((d) => void (d[43]! ^= 1)))).toThrow(/not the hash of its content/);
    expect(() => decodeTokenMeta(address, patched((d) => void (d[9] = d[9]! - 1)))).toThrow(/canonical address/);
    expect(() => decodeTokenMeta(key("elsewhere"), data())).toThrow(/canonical address/);
    expect(() => decodeTokenMeta(address, patched((d) => void (d[11]! ^= 1)))).toThrow(/canonical address/);
    // A record whose text is not UTF-8 (nothing the program can write), at its own address.
    const bad = { name: Uint8Array.of(0x50, 0xc0, 0xaf), symbol: utf8("S"), flags: 0, uri: new Uint8Array(0), doc: new Uint8Array(0) };
    expect(() => decodeTokenMeta(tokenMetaAddress(LAUNCH, metadataHashV2(bad)), tokenMetaAccountData(LAUNCH, bad))).toThrow(/name is not UTF-8/);
    // The document too (it is returned as bytes, but a reader must never be handed one the program could not have stored).
    const badDoc = { name: utf8("N"), symbol: utf8("S"), flags: 0, uri: new Uint8Array(0), doc: Uint8Array.of(0x7b, 0xff, 0x7d) };
    expect(() => decodeTokenMeta(tokenMetaAddress(LAUNCH, metadataHashV2(badDoc)), tokenMetaAccountData(LAUNCH, badDoc))).toThrow(/doc is not UTF-8/);
    expect(() => decodeTokenMeta(address, "x" as never)).toThrow(TypeError);
  });
});

describe("reading records: only through an attestation or a certificate", () => {
  const typicalAt = new PublicKey(TYPICAL.tokenMeta.address);
  const withRecord = (conn: AttestConnection): AttestConnection => conn.set(typicalAt, { owner: PROGRAM_IDS.launchpad, data: fromHex(TYPICAL.tokenMeta.data) });
  const attestation = (hash: Uint8Array, version = 3): Uint8Array =>
    attestationAccountBytes({
      version,
      bump: 255,
      launch: version === 3 ? LAUNCH : PublicKey.default,
      pqIdentity: new Uint8Array(32).fill(version === 3 ? 1 : 0),
      leaf: 0,
      metadataHash: version === 3 ? hash : new Uint8Array(32),
      messageHash: new Uint8Array(32),
      slot: 0n,
      notBefore: 0n,
      notAfter: 0n,
      signature: version === 3 ? new Uint8Array(2_508) : new Uint8Array(0),
    });

  it("fetchTokenMeta: the record a hash names, or nothing (an address holding only lamports is nothing)", async () => {
    const conn = vectorLaunch();
    const hash = fromHex(TYPICAL.metadataHash);
    expect(await fetchTokenMeta(conn.asConnection(), LAUNCH, hash)).toBeNull();
    conn.set(typicalAt, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 5 });
    expect(await fetchTokenMeta(conn.asConnection(), LAUNCH, hash)).toBeNull();
    withRecord(conn);
    expect((await fetchTokenMeta(conn.asConnection(), LAUNCH, hash))?.symbol).toBe("PHXCR");
    conn.hiddenAtFinalized.add(typicalAt.toBase58());
    expect(await fetchTokenMeta(conn.asConnection(), LAUNCH, hash, { commitment: "finalized" })).toBeNull();
    conn.set(typicalAt, { owner: key("impostor-program"), data: fromHex(TYPICAL.tokenMeta.data) });
    await expect(fetchTokenMeta(conn.asConnection(), LAUNCH, hash)).rejects.toThrow(/owned by/);
  });

  it("fetchTokenMetaForLaunch: through Attestation.metadata_hash only (a junk record of the launch is never returned)", async () => {
    const conn = withRecord(vectorLaunch());
    // Junk under the launch, at its own address: inert.
    const junk = { name: "Phalanx Cryo Token", symbol: "PHXCR", doc: '{"description":"phish"}' };
    conn.set(tokenMetaAddress(LAUNCH, metadataHashV2(junk)), { owner: PROGRAM_IDS.launchpad, data: tokenMetaAccountData(LAUNCH, junk) });
    expect(await fetchTokenMetaForLaunch(conn.asConnection(), LAUNCH)).toBeNull(); // no attestation yet
    conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: attestation(new Uint8Array(32), 0) });
    expect(await fetchTokenMetaForLaunch(conn.asConnection(), LAUNCH)).toBeNull(); // burn-only (empty)
    conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: attestation(fromHex(TYPICAL.metadataHash)) });
    const got = await fetchTokenMetaForLaunch(conn.asConnection(), LAUNCH);
    expect(got?.tokenMeta.publicKey.toBase58()).toBe(TYPICAL.tokenMeta.address);
    expect(toHex(got!.tokenMeta.doc)).toBe(TYPICAL.record.docHex);
    conn.delete(typicalAt);
    await expect(fetchTokenMetaForLaunch(conn.asConnection(), LAUNCH)).rejects.toThrow(/names a metadata record that does not exist/);
  });

  it("fetchTokenMetaForMint: through Certificate.metadata only; the record must be the certificate's launch's", async () => {
    const conn = withRecord(vectorLaunch());
    const mint = key("meta/mint");
    expect(await fetchTokenMetaForMint(conn.asConnection(), mint)).toBeNull();
    const cert = (launch: PublicKey, metadata: PublicKey, baseMint = mint): Uint8Array => {
      const codec = idlCodecs().launchpad;
      const zero = codec.decodeAccount<Record<string, unknown>>("Certificate", concatBytes([codec.accountDiscriminator("Certificate"), new Uint8Array(CERTIFICATE.ACCOUNT_LEN - 8)]));
      return accountBytes("launchpad", "Certificate", { ...zero, version: 4, launch, baseMint, metadata });
    };
    conn.set(certificateAddress(mint), { owner: PROGRAM_IDS.launchpad, data: cert(LAUNCH, typicalAt) });
    const got = await fetchTokenMetaForMint(conn.asConnection(), mint);
    expect([got?.certificate.metadata.toBase58(), got?.tokenMeta.name]).toEqual([TYPICAL.tokenMeta.address, "Phalanx Cryo Token"]);
    expect(new DataView(conn.get(certificateAddress(mint))!.data.buffer).byteLength).toBe(CERTIFICATE.ACCOUNT_LEN);
    expect(toHex(conn.get(certificateAddress(mint))!.data.subarray(CERTIFICATE.METADATA_OFFSET, CERTIFICATE.METADATA_OFFSET + 32))).toBe(toHex(typicalAt.toBytes()));
    // A version-3 certificate (487 bytes, before creator rules) reads the same way.
    conn.set(certificateAddress(mint), { owner: PROGRAM_IDS.launchpad, data: cert(LAUNCH, typicalAt).slice(0, CERTIFICATE.V3_ACCOUNT_LEN).map((b, i) => (i === 8 ? 3 : b)) });
    expect((await fetchTokenMetaForMint(conn.asConnection(), mint))?.certificate.version).toBe(3);
    conn.set(certificateAddress(mint), { owner: PROGRAM_IDS.launchpad, data: cert(key("another launch"), typicalAt) });
    await expect(fetchTokenMetaForMint(conn.asConnection(), mint)).rejects.toThrow(/belongs to another launch/);
    conn.set(certificateAddress(mint), { owner: PROGRAM_IDS.launchpad, data: cert(LAUNCH, key("nothing here")) });
    await expect(fetchTokenMetaForMint(conn.asConnection(), mint)).rejects.toThrow(/does not exist/);
    // A certificate at this mint's address that names another mint is not this mint's (an RPC that is dishonest or broken).
    conn.set(certificateAddress(mint), { owner: PROGRAM_IDS.launchpad, data: cert(LAUNCH, typicalAt, key("meta/another mint")) });
    await expect(fetchTokenMetaForMint(conn.asConnection(), mint)).rejects.toThrow(/does not belong to this mint/);
  });
});

describe("buildPublishMetadataTx and sendPublishMetadataTx (landed by a model of the program)", () => {
  const payer = Keypair.fromSeed(fromHex(v.publishTypical.payerSeed));

  it("the typical record: a v1 transaction from the throwaway payer (1,460 B, 100,000 CU, 2 MiB), its rent from the cluster; it lands as the vectors' bytes", async () => {
    const conn = vectorLaunch();
    const built = (await buildPublishMetadataTx(conn.asConnection(), { launch: LAUNCH, payer, metadata: typical })) as PublishMetadataReady;
    expect(built.status).toBe("ready");
    expect(built.sizeBytes).toBe(1_460);
    expect(built.sizeBytes).toBe(publishTransactionSize(typical));
    const d = decodeV1Transaction(built.tx);
    expect([d.computeUnitLimit, d.loadedAccountsDataSizeLimit, d.priorityFeeLamports]).toEqual([PUBLISH_COMPUTE_UNITS, 2 * 1024 * 1024, null]);
    expect(d.accountKeys[0]!.equals(payer.publicKey)).toBe(true);
    expect(toHex(d.instructions[0]!.data)).toBe(v.publishTypical.data);
    expect(built.tokenMeta.toBase58()).toBe(TYPICAL.tokenMeta.address);
    expect(toHex(built.metadataHash)).toBe(TYPICAL.metadataHash);
    expect(built.rentLamports).toBe(BigInt((128 + 1_244) * 6_960));
    expect(built.fundingLamports).toBe(built.rentLamports + 5_000n);
    conn.set(payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(built.fundingLamports) });
    const record = await sendPublishMetadataTx(conn.asConnection(), built);
    expect(toHex(conn.get(built.tokenMeta)!.data)).toBe(TYPICAL.tokenMeta.data);
    expect(record.publicKey.equals(built.tokenMeta)).toBe(true);
    expect(conn.get(payer.publicKey)!.lamports).toBe(0);
    // Idempotent: published (by anyone), nothing to send.
    const again = await buildPublishMetadataTx(conn.asConnection(), { launch: LAUNCH, payer, metadata: typical });
    expect(again.status).toBe("already-published");
    expect(again.status === "already-published" && again.account.publicKey.toBase58()).toBe(TYPICAL.tokenMeta.address);
  });

  it("a priority fee, and the publish fee at a price", () => {
    expect(publishTxConfig()).toEqual({ computeUnitLimit: 100_000, loadedAccountsDataSizeLimit: 2 * 1024 * 1024, priorityFeeLamports: null });
    expect(publishTxConfig({ computeUnitPrice: 1_000_000n }).priorityFeeLamports).toBe(100_000n);
    expect(publishFeeLamports({ computeUnitPrice: 1_000_000n })).toBe(105_000n);
    expect(() => publishTxConfig({ loadedAccountsDataSizeLimit: 0 })).toThrow(/loadedAccountsDataSizeLimit/);
  });

  it("refuses, before signing, a record the program would refuse (its error first), a missing or live launch", async () => {
    const conn = vectorLaunch();
    const c = conn.asConnection();
    await expect(buildPublishMetadataTx(c, { launch: LAUNCH, payer, metadata: { ...typical, flags: 3 } })).rejects.toThrow(/would fail with InvalidMetadataFlags \(6045\)/);
    await expect(buildPublishMetadataTx(c, { launch: LAUNCH, payer, metadata: { name: "N", symbol: "S", doc: "x".repeat(3_073) } })).rejects.toThrow(/MetadataTooLong \(6046\)/);
    await expect(buildPublishMetadataTx(c, { launch: LAUNCH, payer, metadata: { name: "", symbol: "S" } })).rejects.toThrow(/InvalidMetadata \(6016\)/);
    await expect(buildPublishMetadataTx(c, { launch: key("no launch"), payer, metadata: typical })).rejects.toThrow(/does not exist/);
    await expect(buildPublishMetadataTx(c, { launch: LAUNCH, payer: payer.publicKey as never, metadata: typical })).rejects.toThrow(/Keypair/);
    const live = Uint8Array.from(conn.get(LAUNCH)!.data);
    live[13] = 1; // LaunchStatus::Live
    conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: live });
    await expect(buildPublishMetadataTx(c, { launch: LAUNCH, payer, metadata: typical })).rejects.toThrow(/already live \(WrongLaunchState\)/);
    expect(conn.sent).toHaveLength(0);
  });

  it("every vector record lands, at its address, with exactly its bytes; a pre-funded address is taken over (only the missing rent is paid)", async () => {
    for (const cs of v.cases) {
      const conn = vectorLaunch();
      const r = recordOf(cs.record);
      const built = (await buildPublishMetadataTx(conn.asConnection(), { launch: LAUNCH, payer, metadata: r })) as PublishMetadataReady;
      expect(built.sizeBytes, cs.name).toBeLessThanOrEqual(3_621);
      // Someone sent lamports to the record's address first.
      conn.set(built.tokenMeta, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 1_000_000 });
      conn.set(payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(built.fundingLamports - 1_000_000n) });
      await sendPublishMetadataTx(conn.asConnection(), built);
      expect(toHex(conn.get(built.tokenMeta)!.data), cs.name).toBe(cs.tokenMeta.data);
      expect(conn.get(payer.publicKey)!.lamports, cs.name).toBe(0);
    }
  });

  it("a send that does not land throws (build again); one that fails while the record is there (a racing copy) returns the record", async () => {
    const conn = vectorLaunch();
    const built = (await buildPublishMetadataTx(conn.asConnection(), { launch: LAUNCH, payer, metadata: typical })) as PublishMetadataReady;
    // One lamport short of the record's rent plus the fee: refused before anything is sent.
    conn.set(payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(built.fundingLamports) - 1 });
    const short = await sendPublishMetadataTx(conn.asConnection(), built).catch((e: unknown) => e);
    expect(short).toBeInstanceOf(PublishPayerFundingError);
    expect([(short as PublishPayerFundingError).balance, (short as PublishPayerFundingError).required]).toEqual([built.fundingLamports - 1n, built.fundingLamports]);
    expect(conn.sent).toHaveLength(0);
    conn.set(payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(built.fundingLamports) });
    conn.dropSends = true;
    await expect(sendPublishMetadataTx(conn.asConnection(), built)).rejects.toThrow(/did not land .*build it again/);
    // A racing copy published the record meanwhile: this send still fails (dropped), but the record is there and is returned.
    conn.set(built.tokenMeta, { owner: PROGRAM_IDS.launchpad, data: fromHex(TYPICAL.tokenMeta.data) });
    expect((await sendPublishMetadataTx(conn.asConnection(), built)).publicKey.equals(built.tokenMeta)).toBe(true);
    conn.dropSends = false;
    expect((await sendPublishMetadataTx(conn.asConnection(), built)).publicKey.equals(built.tokenMeta)).toBe(true);
    await expect(sendPublishMetadataTx(conn.asConnection(), { status: "already-published" } as never)).rejects.toThrow(/status ready/);
  });

  it("waitForTokenMeta: until the record is final; a timeout and an abort throw", async () => {
    const conn = withFinalLag();
    const hash = fromHex(TYPICAL.metadataHash);
    let polls = 0;
    const got = await waitForTokenMeta(conn.asConnection(), LAUNCH, hash, {
      sleep: async () => {
        if (++polls === 3) conn.hiddenAtFinalized.clear();
      },
    });
    expect([got.symbol, polls]).toEqual(["PHXCR", 3]);
    const stuck = withFinalLag();
    await expect(waitForTokenMeta(stuck.asConnection(), LAUNCH, hash, { timeoutMs: 4_000, pollIntervalMs: 2_000, sleep: async () => undefined })).rejects.toThrow(/is not finalized after 4000 ms/);
    expect((await waitForTokenMeta(stuck.asConnection(), LAUNCH, hash, { commitment: "confirmed", sleep: async () => undefined })).symbol).toBe("PHXCR");
    const ac = new AbortController();
    const p = waitForTokenMeta(stuck.asConnection(), LAUNCH, hash, { signal: ac.signal, sleep: async () => ac.abort(new Error("left")) });
    await expect(p).rejects.toThrow(/left/);
    await expect(waitForTokenMeta(stuck.asConnection(), LAUNCH, hash, { pollIntervalMs: 0 })).rejects.toThrow(/pollIntervalMs/);

    function withFinalLag(): AttestConnection {
      const c = vectorLaunch();
      c.set(new PublicKey(TYPICAL.tokenMeta.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(TYPICAL.tokenMeta.data) });
      c.hiddenAtFinalized.add(TYPICAL.tokenMeta.address);
      return c;
    }
  });
});

describe("the throwaway payer's funding (rents from the cluster)", () => {
  const rent = (n: number): bigint => BigInt((128 + n) * 6_960);

  it("record rent + publish fee + identity and attestation rents + attest fee; existing accounts are not counted", async () => {
    const conn = vectorLaunch();
    const c = conn.asConnection();
    const all = await throwawayPayerFunding(c, { metadata: typical });
    expect(all).toEqual({
      lamports: rent(1_244) + rent(196) + rent(2_708) + 10_000n,
      tokenMetaRent: rent(1_244),
      identityRent: rent(196),
      attestationRent: rent(2_708),
      publishFee: 5_000n,
      rulesRent: 0n,
      publishRulesFee: 0n,
      attestFee: 5_000n,
      rentFloor: 0n,
    });
    // At mainnet's 5,080 lamports per byte: 6,969,760 + 1,645,920 + 14,406,880 + two fees.
    conn.rentPerByteYear = 2_540;
    expect((await throwawayPayerFunding(c, { metadata: typical })).lamports).toBe(23_032_560n);
    conn.rentPerByteYear = 3_480;
    // Priced transactions.
    const priced = await throwawayPayerFunding(c, { metadata: typical, publish: { computeUnitPrice: 1_000_000n }, attest: { computeUnitPrice: 1_000_000n } });
    expect([priced.publishFee, priced.attestFee]).toEqual([105_000n, 305_000n]);
    // Without a record: the attestation alone.
    expect((await throwawayPayerFunding(c)).lamports).toBe(rent(196) + rent(2_708) + 5_000n);
    // The record published already (by anyone): neither its rent nor the publish fee.
    conn.set(new PublicKey(TYPICAL.tokenMeta.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(TYPICAL.tokenMeta.data) });
    const published = await throwawayPayerFunding(c, { metadata: typical, launch: LAUNCH, lmsPublicKey: new Uint8Array(56).fill(9) });
    expect([published.tokenMetaRent, published.publishFee, published.lamports]).toEqual([0n, 0n, rent(196) + rent(2_708) + 5_000n]);
    await expect(throwawayPayerFunding(c, { metadata: { name: "", symbol: "S" } })).rejects.toThrow(/record is invalid \(InvalidMetadata\)/);
    await expect(throwawayPayerFunding(c, { launch: LAUNCH })).rejects.toThrow(/both/);
  });

  it("buildFundThrowawayPayerTx: one legacy transfer from the wallet, signed by the wallet; never to itself", async () => {
    const conn = vectorLaunch();
    const wallet = key("meta/wallet");
    const payer = Keypair.generate().publicKey;
    const r = await buildFundThrowawayPayerTx(conn.asConnection(), wallet, payer, { metadata: typical });
    expect(r.lamports).toBe(r.funding!.lamports);
    expect(r.tx.feePayer!.equals(wallet)).toBe(true);
    expect(r.tx.instructions).toHaveLength(1);
    const explicit = await buildFundThrowawayPayerTx(conn.asConnection(), wallet, payer, { lamports: 7n });
    expect([explicit.lamports, explicit.funding]).toEqual([7n, null]);
    await expect(buildFundThrowawayPayerTx(conn.asConnection(), wallet, wallet)).rejects.toThrow(/fresh key/);
    await expect(buildFundThrowawayPayerTx(conn.asConnection(), wallet, payer, { lamports: 0n })).rejects.toThrow(/positive/);
  });
});

describe("the certificate and the clock in tests", () => {
  it("the world clock helper encodes unix seconds at byte 32", () => {
    const c = clock(1_767_225_600);
    expect(new DataView(c.buffer).getBigInt64(32, true)).toBe(1_767_225_600n);
  });
});

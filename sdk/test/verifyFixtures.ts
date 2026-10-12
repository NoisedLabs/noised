/**
 * Fixtures of the verifier tests:
 *
 * - `vectors/lms.json` (a copy of tests/integration/vectors/lms.json, written
 *   by the Rust `noised-lmots` signer and the launchpad's layouts, message
 *   v3, attestation v3): the creator identity whose key signs, its
 *   Rust-produced Identity and Attestation accounts, the burn-only empty
 *   attestation;
 * - `vectors/metadata.json`: the typical record's icon (a 32x32 PNG);
 * - `vectors/programmable.json` (`PROG`): the creator rules records the
 *   launchpad writes (`publish_rules`) and an attestation v3 that signs the
 *   typical rules, with its launch, identity and metadata record;
 * - `withPq(world)`: the mocked launch of `./world.ts`, attested the way
 *   `publish_metadata` + `attest_launch` + `launch` leave it: the record
 *   (name, symbol, a document with the vector icon) published at the address
 *   of its hash (bytes written by the test's own model of the program,
 *   `./attest_world.ts`), the mint holding its name, symbol and derived uri,
 *   the vector identity's key (same public key and identity id as lms.json)
 *   signing the world launch's 221-byte message v3 (no rules by default),
 *   the Identity account the Rust vector's bytes (leaf 511 used), the
 *   certificate (v4) and the launch naming that identity, leaf, slot and
 *   record, and the executed batch having ended the snipe shield;
 * - `withRules(world, bytes)`: the same launch with creator rules: the rules
 *   record published (`publish_rules`'s bytes, the test's own model), the
 *   identity signing their hash, the certificate recording it with
 *   `RULES_BOUND` (8,191) and the hook policy holding the bytes;
 * - `vectors/damm_v2_migration_configs.json` (Meteora's six DAMM v2
 *   migration configs, read from mainnet) and `pristinePoolFees`: a pool's
 *   fees exactly as DAMM v2 `PoolFeesConfig::to_pool_fees_struct` writes
 *   them when DBC migrates through that config.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { CERTIFICATE_RULES_BOUND, PQ_IDENTITY, PROGRAM_IDS } from "../src/constants.js";
import { attestationAddress, identityAddress } from "../src/pda.js";
import { attestationMessage } from "../src/pq/identity.js";
import { lmsKeygenSync, signLeafDeterministic, type LmsKeyPair } from "../src/pq/lms.js";
import { emulatedLaunchRulesBytes, emulatedMetadataHash, emulatedRulesHash, emulatedTokenMetaBytes, rulesPda } from "./attest_world.js";
import { ext, readJson } from "./helpers.js";
import { accountBytes, codec, type World } from "./world.js";

// ------------------------------------------------------------- lms.json ---

export interface LmsVectorSubset {
  identity: { seed: string; i: string; publicKey: string; identityId: string; identityAccount: string };
  metadata: { name: string; symbol: string; flags: number; uri: string; doc: string; hash: string; tokenMetaAccount: string };
  attestation: {
    launch: string;
    paramsHash: string;
    creator: string;
    metadataHash: string;
    /** All zero: the lms.json launch signs no rules. */
    rulesHash: string;
    notBefore: number;
    notAfter: number;
    landsAt: number;
    message: string;
    messageHash: string;
    attestationAccount: string;
  };
  signatures: { q: number; signature: string }[];
  accounts: {
    identity: { address: string; bump: number; usedLeaves: number[]; data: string };
    attestation: { address: string; bump: number; leaf: number; slot: number; data: string };
    launch: { address: string; bump: number; data: string };
    tokenMeta: { address: string; bump: number; data: string };
  };
  burnOnly: { emptyAttestation: string };
}

export const LMS = readJson<LmsVectorSubset>("./vectors/lms.json");

/** The typical record's icon of `vectors/metadata.json`: a 32x32 PNG with 16 colours. */
export const ICON_PNG = fromHex(readJson<{ icon: { png: string } }>("./vectors/metadata.json").icon.png);

// ---------------------------------------------------- programmable.json ---

export interface ProgrammableVectorSubset {
  /** The rules records `publish_rules` writes: the typical set (286 bytes) and the largest (1,228 bytes). */
  rules: { name: string; address: string; bump: number; len: number; rulesHash: string; bytes: string; accountData: string }[];
  /** A Configured launch (guard 3,600 s) whose identity signed the typical rules. */
  launch: { address: string; creator: string; data: string; guardSecs: number; paramsHash: string; metadataHash: string; pqIdentity: string; tokenMeta: string; tokenMetaData: string; slot: number };
  identity: { address: string; data: string };
  /** The attestation v3 binding the typical rules (`q` the leaf). */
  attestation: { address: string; accountData: string; message: string; messageHash: string; rulesHash: string; signature: string; q: number; notBefore: number; notAfter: number };
  parameters: { certificate: { allChecks: number; rulesBound: number; withRules: number; accountLen: number; rulesHashOffset: number }; noRulesHash: string };
}

/** `vectors/programmable.json` (a copy of tests/integration/vectors/programmable.json). */
export const PROG = readJson<ProgrammableVectorSubset>("./vectors/programmable.json");

let keyPair: LmsKeyPair | null = null;
/** The vector identity's LMS key pair (keygen once, about a second). */
export function vectorIdentity(): LmsKeyPair {
  keyPair ??= lmsKeygenSync({ seed: fromHex(LMS.identity.seed), id: fromHex(LMS.identity.i) });
  return keyPair;
}

/** Bytes of a launchpad `Identity` account for the vector key with these leaves used. */
export function identityBytes(usedLeaves: readonly number[], publicKey: Uint8Array = fromHex(LMS.identity.publicKey)): Uint8Array {
  const used = new Uint8Array(128);
  for (const q of usedLeaves) used[q >> 3]! |= 1 << (q & 7);
  const [, bump] = PublicKey.findProgramAddressSync([utf8("identity"), sha256(Uint8Array.of(0x21, ...publicKey))], PROGRAM_IDS.launchpad);
  return accountBytes("launchpad", "Identity", { version: 1, bump, publicKey, used, usedCount: new Set(usedLeaves).size });
}

// --------------------------------------------------------- PQ world -----

/** A record's text fields as bytes (what the program hashes and stores). */
export interface WorldRecord {
  name: Uint8Array;
  symbol: Uint8Array;
  flags: number;
  uri: Uint8Array;
  doc: Uint8Array;
}

/** The world's document: compact JSON in the SDK's key order, with the vector icon inline (written here by hand). */
export const WORLD_DOC = utf8(`{"name":"Verified","symbol":"VER","description":"verifier fixture","image":"data:image/png;base64,${btoa(String.fromCharCode(...ICON_PNG))}"}`);

/** `metadataHashV2` of a world record (the test's own model of `pq::metadata_hash_v2`). */
export const recordHash = (r: WorldRecord): Uint8Array => emulatedMetadataHash(r.name, r.symbol, r.flags, r.uri, r.doc);

/** `["metadata", launch, hash]`. */
export function recordAddress(launch: PublicKey, r: WorldRecord): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("metadata"), launch.toBytes(), recordHash(r)], PROGRAM_IDS.launchpad)[0];
}

/** The uri `launch` derives for a world record: "" | the data uri of the document | the external uri. */
export function worldTokenUri(r: WorldRecord): string {
  if (r.flags === 1) return `data:application/json;base64,${btoa(String.fromCharCode(...r.doc))}`;
  if (r.flags === 2) return new TextDecoder().decode(r.uri);
  return "";
}

export interface PqFixture {
  /** Leaf recorded in the attestation and the certificate (the vector's identity account marks 511). */
  leaf: number;
  /** Leaf the signature is made with (default: `leaf`). */
  signLeaf: number;
  slot: bigint;
  notBefore: bigint;
  notAfter: bigint;
  /** The record the identity signed, published at its address (and, by default, what the mint holds). */
  record: WorldRecord;
  /** The record account: published (the program's bytes), missing, or other bytes. */
  recordAccount: "published" | "missing" | { owner: PublicKey; data: Uint8Array };
  /** The name, symbol and uri the mint holds (null: the record's name, symbol and derived uri). */
  mintMetadata: { name: string; symbol: string; uri: string } | null;
  /** What lands at the attestation PDA. */
  attestation: "attested" | "empty" | "missing";
  /** Last-moment changes to the attestation record before it is encoded. */
  patch: (record: Record<string, unknown>) => void;
  /** Leaves the identity account marks used; null = the account is absent. Default [511]: the Rust vector bytes verbatim. */
  usedLeaves: number[] | null;
  /** The params_hash and creator the identity signed (captured from the world at `withPq`). */
  paramsHash: Uint8Array;
  creator: PublicKey;
  /** When the executed batch ended the snipe shield (written into the hook policy at `withPq`). */
  executedAt: bigint;
  /** The creator rules hash the identity signs (default all zero: no rules; `withRules` sets it). */
  rulesHash: Uint8Array;
  /** The PXR1 bytes of the rules record published at `["rules", launch, hash(bytes)]` (null: none). */
  rules: Uint8Array | null;
  /** The rules record account: published (the program's bytes), missing, or other bytes. */
  rulesAccount: "published" | "missing" | { owner: PublicKey; data: Uint8Array };
}

export type PqWorld = World & { pq: PqFixture };

const signatures = new Map<string, Uint8Array>();
function sign(leaf: number, message: Uint8Array): Uint8Array {
  const k = `${leaf}:${toHex(message)}`;
  let s = signatures.get(k);
  if (s === undefined) {
    s = signLeafDeterministic(vectorIdentity(), leaf, message);
    signatures.set(k, s);
  }
  return s;
}

/** The 221-byte message v3 the world's attestation signs, as `attest_launch` builds it. */
export function worldMessage(w: PqWorld): Uint8Array {
  const p = w.pq;
  return attestationMessage({
    launch: w.launch,
    paramsHash: p.paramsHash,
    creator: p.creator,
    metadataHash: recordHash(p.record),
    rulesHash: p.rulesHash,
    notBefore: p.notBefore,
    notAfter: p.notAfter,
  });
}

/** `["rules", launch, hash]` of the test's own model (attest_world.ts). */
export function worldRulesAddress(w: World, bytes: Uint8Array): PublicKey {
  return rulesPda(w.launch, emulatedRulesHash(bytes))[0];
}

/**
 * Give an attested world creator rules, the way `publish_rules` +
 * `attest_launch` + `launch` leave them: the record published at the
 * address of their hash, the identity signing that hash, the certificate
 * recording it with `RULES_BOUND` (checks 8,191) and the hook policy holding
 * exactly the bytes. Tests mutate `w.cert`, `w.policy` or `w.pq` afterwards.
 */
export function withRules(w: PqWorld, bytes: Uint8Array): PqWorld {
  const hash = emulatedRulesHash(bytes);
  Object.assign(w.pq, { rules: bytes, rulesHash: hash, rulesAccount: "published" });
  w.cert["rulesHash"] = hash;
  w.cert["checks"] = (w.cert["checks"] as number) | CERTIFICATE_RULES_BOUND;
  w.policy["rules"] = bytes;
  return w;
}

/**
 * Attest `w` with the vector identity (see the module docs). The world's
 * build then also writes the record, the Attestation and the Identity
 * accounts from `w.pq`, the mint's metadata and the certificate's
 * `metadata`.
 */
export function withPq(w: World): PqWorld {
  const pw = w as PqWorld;
  const ls = w.launchState as { launchTs: bigint; commitEndTs: bigint; paramsHash: Uint8Array; creator: PublicKey };
  const id = fromHex(LMS.identity.identityId);
  const notBefore = ls.launchTs - 30n;
  pw.pq = {
    leaf: 511,
    signLeaf: 511,
    slot: 399_999_000n,
    notBefore,
    notAfter: notBefore + 3_600n,
    record: { name: utf8("Verified"), symbol: utf8("VER"), flags: 0, uri: new Uint8Array(0), doc: WORLD_DOC },
    recordAccount: "published",
    mintMetadata: null,
    attestation: "attested",
    patch: () => {},
    usedLeaves: [511],
    paramsHash: ls.paramsHash,
    creator: ls.creator,
    executedAt: ls.commitEndTs + 42n,
    rulesHash: new Uint8Array(32),
    rules: null,
    rulesAccount: "published",
  };
  Object.assign(w.cert, { pqIdentity: id, pqLeaf: 511, attestedSlot: 399_999_000n });
  w.launchState["pqIdentity"] = id;
  // The batch executed (world default): execute_batch ended the snipe shield then.
  w.policy["snipeShieldEndTs"] = pw.pq.executedAt;
  const build = w.build;
  const installed = new WeakSet<object>();
  w.mintOpts.extensions = w.mintOpts.extensions.map((e) => {
    if (e.type !== 19) return e;
    const mine = { ...e };
    installed.add(mine);
    return mine;
  });
  pw.build = () => {
    const p = pw.pq;
    const r = p.record;
    const recordAt = recordAddress(w.launch, r);
    // The mint holds the record's name, symbol and derived uri; the certificate names the record.
    const m = p.mintMetadata ?? { name: new TextDecoder().decode(r.name), symbol: new TextDecoder().decode(r.symbol), uri: worldTokenUri(r) };
    // Only the extension this fixture installed follows the record: a test's own TokenMetadata stays as it is.
    w.mintOpts.extensions = w.mintOpts.extensions.map((e) => {
      if (e.type !== 19 || !installed.has(e)) return e;
      const next = ext.tokenMetadata({ updateAuthority: null, mint: w.mint, ...m });
      installed.add(next);
      return next;
    });
    if ((w.cert["metadata"] as PublicKey).equals(PublicKey.default)) w.cert["metadata"] = recordAt;
    build();
    if (p.recordAccount === "missing") w.conn.delete(recordAt);
    else if (p.recordAccount === "published") w.conn.set(recordAt, { owner: PROGRAM_IDS.launchpad, data: emulatedTokenMetaBytes(w.launch, r.name, r.symbol, r.flags, r.uri, r.doc) });
    else w.conn.set(recordAt, p.recordAccount);
    if (p.rules !== null) {
      const rulesAt = worldRulesAddress(w, p.rules);
      if (p.rulesAccount === "missing") w.conn.delete(rulesAt);
      else if (p.rulesAccount === "published") w.conn.set(rulesAt, { owner: PROGRAM_IDS.launchpad, data: emulatedLaunchRulesBytes(w.launch, p.rules) });
      else w.conn.set(rulesAt, p.rulesAccount);
    }
    const att = attestationAddress(w.launch);
    const [, bump] = PublicKey.findProgramAddressSync([utf8("attestation"), w.launch.toBytes()], PROGRAM_IDS.launchpad);
    if (p.attestation === "missing") w.conn.delete(att);
    else if (p.attestation === "empty") w.conn.set(att, { owner: PROGRAM_IDS.launchpad, data: fromHex(LMS.burnOnly.emptyAttestation) });
    else {
      const message = worldMessage(pw);
      const record: Record<string, unknown> = {
        version: PQ_IDENTITY.ATTESTATION_VERSION,
        bump,
        launch: w.launch,
        pqIdentity: id,
        leaf: p.leaf,
        metadataHash: recordHash(r),
        rulesHash: p.rulesHash,
        messageHash: sha256(message),
        slot: p.slot,
        notBefore: p.notBefore,
        notAfter: p.notAfter,
        signature: sign(p.signLeaf, message),
      };
      p.patch(record);
      w.conn.set(att, { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Attestation", record) });
    }
    const identity = identityAddress(fromHex(LMS.identity.publicKey));
    if (p.usedLeaves === null) w.conn.delete(identity);
    else {
      const verbatim = p.usedLeaves.length === 1 && p.usedLeaves[0] === 511;
      w.conn.set(identity, { owner: PROGRAM_IDS.launchpad, data: verbatim ? fromHex(LMS.accounts.identity.data) : identityBytes(p.usedLeaves) });
    }
  };
  return pw;
}

// ------------------------------------------------- DAMM v2 migration ----

export interface DammConfigVector {
  option: number;
  tierBps: number;
  address: string;
  owner: string;
  space: number;
  data: string;
}

export const DAMM_CONFIGS = readJson<{ configs: DammConfigVector[] }>("./vectors/damm_v2_migration_configs.json").configs;

interface ConfigPoolFees {
  baseFee: { data: Uint8Array };
  dynamicFee: Record<string, unknown> & { initialized: number };
  protocolFeePercent: number;
  referralFeePercent: number;
  compoundingFeeBps: number;
}

/** The account data of a config vector. */
export function configBytes(v: DammConfigVector): Uint8Array {
  return Uint8Array.from(atob(v.data), (ch) => ch.charCodeAt(0));
}

/** The decoded DAMM v2 `Config` of a vector (IDL-driven). */
export function decodeDammConfig(v: DammConfigVector): { poolFees: ConfigPoolFees } & Record<string, unknown> {
  return codec.dammV2.decodeAccount("Config", configBytes(v));
}

/**
 * Write into `poolFees` (a decoded `PoolFeesStruct`) what DAMM v2's
 * `PoolFeesConfig::to_pool_fees_struct(init_sqrt_price)` produces from the
 * config of fee option `option`: the base fee info verbatim, the protocol,
 * referral and compounding fields, the dynamic fee parameters
 * (`DynamicFeeConfig::to_dynamic_fee_struct`: runtime fields zero; all
 * default when the config has none), and `init_sqrt_price`.
 */
export function pristinePoolFees(poolFees: Record<string, unknown>, option: number, initSqrtPrice: bigint): void {
  const cfg = decodeDammConfig(DAMM_CONFIGS[option]!).poolFees;
  const pf = poolFees as {
    baseFee: { baseFeeInfo: { data: Uint8Array } };
    dynamicFee: Record<string, unknown>;
    protocolFeePercent: number;
    referralFeePercent: number;
    compoundingFeeBps: number;
    initSqrtPrice: bigint;
  };
  pf.baseFee.baseFeeInfo.data = cfg.baseFee.data.slice();
  pf.protocolFeePercent = cfg.protocolFeePercent;
  pf.referralFeePercent = cfg.referralFeePercent;
  pf.compoundingFeeBps = cfg.compoundingFeeBps;
  const d = cfg.dynamicFee;
  Object.assign(pf.dynamicFee, {
    initialized: d.initialized === 0 ? 0 : 1,
    maxVolatilityAccumulator: d.initialized === 0 ? 0 : d["maxVolatilityAccumulator"],
    variableFeeControl: d.initialized === 0 ? 0 : d["variableFeeControl"],
    binStep: d.initialized === 0 ? 0 : d["binStep"],
    filterPeriod: d.initialized === 0 ? 0 : d["filterPeriod"],
    decayPeriod: d.initialized === 0 ? 0 : d["decayPeriod"],
    reductionFactor: d.initialized === 0 ? 0 : d["reductionFactor"],
    binStepU128: d.initialized === 0 ? 0n : d["binStepU128"],
    lastUpdateTimestamp: 0n,
    sqrtPriceReference: 0n,
    volatilityAccumulator: 0n,
    volatilityReference: 0n,
  });
  pf.initSqrtPrice = initSqrtPrice;
}

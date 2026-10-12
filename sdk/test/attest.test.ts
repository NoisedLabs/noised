/**
 * `attest_launch` from the SDK (`src/pq/attest.ts`), byte for byte against
 * `vectors/lms.json` (a copy of tests/integration/vectors/lms.json, message
 * v2, written by tests/integration/tests/lms_vectors.rs and landed on the
 * launchpad build by vectors_onchain.rs):
 *
 * - the instruction (data, the six accounts with the metadata record at
 *   index 4) and the signed v1 transaction of the vector (throwaway payer
 *   from `payerSeed`, 300,000 CU, 2 MiB, the fixed blockhash), from the pure
 *   builders and from `buildAttestLaunchTx` itself (the leaf probe lands on
 *   the vector's leaf 511 when 500..510 are taken on-chain or in the ledger);
 * - the constant transaction size (2,972 B) and the payer funding from the
 *   cluster's rent (21,775,880 / 15,895,240 lamports);
 * - every refusal before signing (cluster, launch, creator, identity,
 *   parameters, window, attestation, a record not published or not final,
 *   the burn-only cap) leaving the ledger untouched;
 * - `confirmAttestation` on the vector's attested account and on the empty
 *   burn-only attestation, with the reason of each burn-only case;
 * - sending through a model of the program: ConstraintSeeds resent with the
 *   same signature, PqLeafUsed read from the accounts, a record lost after
 *   signing re-signed at a new leaf (capped).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, SystemInstruction, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { encodeBase58 } from "../src/codec/base58.js";
import { fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { PQ_IDENTITY, PROGRAM_IDS } from "../src/constants.js";
import { attestationAddress, identityAddress, tokenMetaAddress } from "../src/pda.js";
import {
  ATTEST_COMPUTE_UNITS,
  ATTEST_LOADED_ACCOUNTS_BYTES,
  AttestPayerFundingError,
  AttestRetryLimitError,
  attestationReplaceable,
  attestFeeLamports,
  attestLaunchInstruction,
  attestTransactionSize,
  attestTxConfig,
  buildAttestLaunchTx,
  buildFundAttestPayerTx,
  burnReasons,
  confirmAttestation,
  fundingLamportsForAttest,
  MAX_BURN_ONLY_LANDINGS,
  PendingAttestationError,
  rewrapAttestTx,
  sendAttestLaunchTx,
  signAttestTransaction,
  type AttestLaunchBaseArgs,
  type AttestLaunchReady,
  type BuildAttestLaunchArgs,
  type BurnReason,
} from "../src/pq/attest.js";
import { deriveIdentity, deriveIdentityKey, parseAttestationMessage, type PqIdentity } from "../src/pq/identity.js";
import { acknowledgeUnknownLeaves, createMemoryLeafLedger, reserveAndSign, UnknownLeavesError, type LeafLedger } from "../src/pq/leafLedger.js";
import { lmsKeyPairFromTreeCache, lmsVerify } from "../src/pq/lms.js";
import { customErrorCode } from "../src/rpc/errors.js";
import { GENESIS_HASHES } from "../src/rpc/cluster.js";
import { decodeV1Transaction } from "../src/tx/v1.js";
import { decodeAttestation } from "../src/launch/accounts.js";
import { AttestConnection, attestationAccountBytes, bitmapOf, decodeAttestArgs, emulateAttestLaunch, identityAccountBytes, ProgramError } from "./attest_world.js";
import { readJson } from "./helpers.js";

interface Meta {
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
interface Vectors {
  derivation: { master: string };
  identity: { publicKey: string; identityId: string; identityAccount: string };
  metadata: { name: string; symbol: string; flags: number; uri: string; doc: string; hash: string; tokenMetaAccount: string };
  attestation: {
    launch: string;
    creator: string;
    paramsHash: string;
    message: string;
    messageHash: string;
    metadataHash: string;
    notBefore: number;
    notAfter: number;
    landsAt: number;
    leafProbeStart: number;
  };
  signatures: { q: number; signature: string }[];
  attestLaunch: {
    q: number;
    payer: string;
    payerSeed: string;
    data: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    v1: { accountKeys: string[]; header: number[]; computeUnitLimit: number; loadedAccountsDataSizeLimit: number; recentBlockhash: string; message: string; wire: string };
  };
  accounts: {
    launch: { address: string; data: string };
    identity: { address: string; data: string; usedLeaves: number[] };
    attestation: { address: string; data: string; leaf: number; slot: number };
    tokenMeta: { address: string; bump: number; data: string };
  };
  burnOnly: {
    landsAt: number;
    emptyAttestation: string;
    cases: {
      name: string;
      q: number;
      data: string;
      message: string;
      signature: string;
      publicKey: string;
      identityId: string;
      metadata: Meta;
      metadataHash: string;
      tokenMetaAccount: string;
      terms: { notBefore: number; notAfter: number };
    }[];
  };
}

const v = readJson<Vectors>("./vectors/lms.json");
const LAUNCH = new PublicKey(v.attestation.launch);
const CREATOR = new PublicKey(v.attestation.creator);
const LANDS_AT = BigInt(v.attestation.landsAt);
const WINDOW = { notBefore: BigInt(v.attestation.notBefore), notAfter: BigInt(v.attestation.notAfter) };
const HASH = fromHex(v.attestation.metadataHash);
const RECORD = new PublicKey(v.accounts.tokenMeta.address);
const PAYER = Keypair.fromSeed(fromHex(v.attestLaunch.payerSeed));
const SIG_511 = fromHex(v.signatures.find((s) => s.q === 511)!.signature);
/** Rent at the mocked default: (128 + size) x 6,960 lamports. */
const rent = (size: number): bigint => BigInt((128 + size) * 6_960);

let identity: PqIdentity;

beforeAll(async () => {
  identity = await deriveIdentity(fromHex(v.derivation.master), "localnet", 0);
});

/** The vector launch (Configured, names identity 0) at the vector's landing time, its record published, nothing attested yet. */
function vectorWorld(): AttestConnection {
  const conn = new AttestConnection();
  conn.blockhash = v.attestLaunch.v1.recentBlockhash;
  conn.set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.launch.data) });
  conn.set(RECORD, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.tokenMeta.data) });
  conn.setClock(LANDS_AT);
  return conn;
}

/** Overrides of the test arguments (`expectedParamsHash: undefined` drops the reviewed configuration). */
type ArgsOverride = Partial<AttestLaunchBaseArgs> & { readonly expectedParamsHash?: Uint8Array | undefined; readonly unsafeAcceptAnyParams?: boolean | undefined };

function args(ledger: LeafLedger, over: ArgsOverride = {}): BuildAttestLaunchArgs {
  return { launch: LAUNCH, creator: CREATOR, identity, ledger, metadataHash: HASH, window: WINDOW, payer: PAYER, allowLocalnet: true, expectedParamsHash: fromHex(v.attestation.paramsHash), ...over } as BuildAttestLaunchArgs;
}

/** Where `needle` first occurs in `hay` (-1 if absent). */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * The vector launch as a squatter would create it (review finding): the same
 * creator (a forged Ed25519 key), the same seed, so the same PDA, and the
 * victim's pq_identity copied in, but the squatter's own parameters.
 */
function squattedWorld(): { conn: AttestConnection; squatterParamsHash: Uint8Array } {
  const data = fromHex(v.accounts.launch.data);
  const at = indexOfBytes(data, fromHex(v.attestation.paramsHash));
  if (at < 0) throw new Error("the vector launch does not hold its params_hash");
  const squatterParamsHash = sha256(utf8("the squatter's LaunchParams: every fee to the squatter"));
  data.set(squatterParamsHash, at);
  return { conn: vectorWorld().set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data }), squatterParamsHash };
}

function setIdentityBits(conn: AttestConnection, leaves: Iterable<number>): void {
  conn.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(identity.publicKey, bitmapOf(leaves), 253) });
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
/** Where the vector message's RETIRED public probe v1 starts (90): the vectors' rule, no longer the SDK's. */
const PROBE = v.attestation.leafProbeStart;
/** Where the vector message's secret probe v2 starts for the vector identity (audit 4, ID-F1a): the SDK's leaf for it. */
const start = (): number => identity.keyPair.leafProbeStart(fromHex(v.attestation.message));
/** A ledger that assigned the vector message to the vector's leaf 511 (reserved, never signed): the identity signs it there. */
async function ledgerAt511(): Promise<LeafLedger> {
  const ledger = createMemoryLeafLedger();
  expect(await ledger.reserve(identity.identityId, 511, fromHex(v.attestation.messageHash), { launch: LAUNCH })).toBe("reserved");
  return ledger;
}

describe("attest_launch bytes (pure builders)", () => {
  it("instruction data and accounts (the record at index 4), and the signed v1 transaction, equal the Rust vector", () => {
    expect(PAYER.publicKey.toBase58()).toBe(v.attestLaunch.payer);
    const ix = attestLaunchInstruction({
      payer: PAYER.publicKey,
      launch: LAUNCH,
      lmsPublicKey: fromHex(v.identity.publicKey),
      lmsSignature: SIG_511,
      metadataHash: HASH,
      ...WINDOW,
    });
    expect(toHex(ix.data)).toBe(v.attestLaunch.data);
    expect(toHex(ix.data.subarray(0, 8))).toBe("b518c935f67efd4f");
    expect(ix.programId.equals(PROGRAM_IDS.launchpad)).toBe(true);
    expect(ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))).toEqual(v.attestLaunch.accounts);
    expect(ix.keys).toHaveLength(7);
    // P1c: the rules account last: the launchpad program id for the zero rules hash.
    expect([ix.keys[6]!.pubkey.toBase58(), ix.keys[6]!.isSigner, ix.keys[6]!.isWritable]).toEqual([PROGRAM_IDS.launchpad.toBase58(), false, false]);
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(v.metadata.tokenMetaAccount);
    expect(ix.keys[4]!.pubkey.equals(tokenMetaAddress(LAUNCH, HASH))).toBe(true);
    expect([ix.keys[4]!.isSigner, ix.keys[4]!.isWritable]).toEqual([false, false]);

    const signed = signAttestTransaction(PAYER, ix, v.attestLaunch.v1.recentBlockhash);
    expect(toHex(signed.tx)).toBe(v.attestLaunch.v1.wire);
    expect(signed.sizeBytes).toBe(3_005);
    expect(signed.computeUnitLimit).toBe(v.attestLaunch.v1.computeUnitLimit);
    expect(signed.priorityFeeLamports).toBeNull();
    const d = decodeV1Transaction(signed.tx);
    expect(toHex(d.message)).toBe(v.attestLaunch.v1.message);
    expect(d.accountKeys.map((k) => k.toBase58())).toEqual(v.attestLaunch.v1.accountKeys);
    expect([d.header.numRequiredSignatures, d.header.numReadonlySigned, d.header.numReadonlyUnsigned]).toEqual(v.attestLaunch.v1.header);
    expect([d.computeUnitLimit, d.loadedAccountsDataSizeLimit]).toEqual([ATTEST_COMPUTE_UNITS, ATTEST_LOADED_ACCOUNTS_BYTES]);
    expect(d.loadedAccountsDataSizeLimit).toBe(v.attestLaunch.v1.loadedAccountsDataSizeLimit);
    expect(signed.signature).toBe(encodeBase58(d.signatures[0]!));
  });

  it("refuses a key, signature or metadata hash of the wrong length", () => {
    const base = { payer: PAYER.publicKey, launch: LAUNCH, lmsPublicKey: fromHex(v.identity.publicKey), lmsSignature: SIG_511, metadataHash: HASH, ...WINDOW };
    expect(() => attestLaunchInstruction({ ...base, lmsPublicKey: new Uint8Array(55) })).toThrow(/56 bytes/);
    expect(() => attestLaunchInstruction({ ...base, lmsSignature: SIG_511.subarray(1) })).toThrow(/2508 bytes/);
    expect(() => attestLaunchInstruction({ ...base, metadataHash: new Uint8Array(31) })).toThrow(/32 bytes/);
  });

  it("transaction size: a constant 3,005 B (the vector), + 32 B with creator rules, + 8 B with a priority fee, whatever the records", () => {
    expect(attestTransactionSize()).toBe(fromHex(v.attestLaunch.v1.wire).length);
    expect(attestTransactionSize()).toBe(3_005);
    expect(attestTransactionSize({ priorityFee: true })).toBe(3_013);
    // With rules: one more account (the rules record) in the message; the largest attest transaction.
    expect(attestTransactionSize({ rules: true })).toBe(3_037);
    expect(attestTransactionSize({ rules: true, priorityFee: true })).toBe(3_045);
    expect(attestTransactionSize({ rules: true, priorityFee: true })).toBeLessThanOrEqual(4_096);
    const ix = attestLaunchInstruction({ payer: PAYER.publicKey, launch: LAUNCH, lmsPublicKey: fromHex(v.identity.publicKey), lmsSignature: SIG_511, metadataHash: new Uint8Array(32).fill(7), ...WINDOW });
    expect(signAttestTransaction(PAYER, ix, v.attestLaunch.v1.recentBlockhash, { computeUnitPrice: 1n }).sizeBytes).toBe(3_013);
  });

  it("config words: 300,000 CU and 2 MiB by default; a compute-unit price becomes the v1 priority fee in lamports", () => {
    expect(attestTxConfig()).toEqual({ computeUnitLimit: 300_000, loadedAccountsDataSizeLimit: 2 * 1024 * 1024, priorityFeeLamports: null });
    expect(attestTxConfig({ computeUnitPrice: 1_000_000n }).priorityFeeLamports).toBe(300_000n);
    expect(attestTxConfig({ computeUnitPrice: 3n, computeUnitLimit: 200_000 }).priorityFeeLamports).toBe(1n);
    expect(attestFeeLamports({ computeUnitPrice: 1_000_000n })).toBe(305_000n);
    expect(attestFeeLamports()).toBe(5_000n);
    expect(() => attestTxConfig({ computeUnitLimit: 0 })).toThrow(/computeUnitLimit/);
    expect(() => attestTxConfig({ loadedAccountsDataSizeLimit: 0 })).toThrow(/loadedAccountsDataSizeLimit/);
    expect(attestTxConfig({ loadedAccountsDataSizeLimit: 1 << 20 }).loadedAccountsDataSizeLimit).toBe(1 << 20);
  });
});

describe("payer funding (rent from the cluster, never hard-coded)", () => {
  it("rent(196) + rent(2,708) + 5,000: 21,998,600 at the default rent, 16,057,800 at mainnet's", async () => {
    const conn = vectorWorld();
    expect(await fundingLamportsForAttest(conn.asConnection())).toBe(21_998_600n);
    expect(rent(196) + rent(2_708) + 5_000n).toBe(21_998_600n);
    conn.rentPerByteYear = 2_540;
    expect(await fundingLamportsForAttest(conn.asConnection())).toBe(16_057_800n);
    expect(await fundingLamportsForAttest(conn.asConnection(), { computeUnitPrice: 1_000_000n })).toBe(16_057_800n + 300_000n);
  });

  it("with the launch and key: only the accounts that do not exist yet", async () => {
    const conn = vectorWorld();
    const c = conn.asConnection();
    const o = { launch: LAUNCH, lmsPublicKey: identity.publicKey };
    expect(await fundingLamportsForAttest(c, o)).toBe(21_998_600n);
    setIdentityBits(conn, [1]);
    expect(await fundingLamportsForAttest(c, o)).toBe(21_998_600n - rent(196));
    conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.burnOnly.emptyAttestation) });
    expect(await fundingLamportsForAttest(c, o)).toBe(5_000n);
    await expect(fundingLamportsForAttest(c, { launch: LAUNCH })).rejects.toThrow(/both/);
  });

  it("buildFundAttestPayerTx: a legacy transfer from the wallet to the throwaway payer, signed by the wallet", async () => {
    const conn = vectorWorld();
    const wallet = CREATOR;
    const { tx, lamports } = await buildFundAttestPayerTx(conn.asConnection(), wallet, PAYER.publicKey);
    expect(lamports).toBe(21_998_600n);
    expect(tx.feePayer!.equals(wallet)).toBe(true);
    expect(tx.instructions).toHaveLength(1);
    const t = SystemInstruction.decodeTransfer(tx.instructions[0]!);
    expect([t.fromPubkey.toBase58(), t.toPubkey.toBase58(), t.lamports]).toEqual([wallet.toBase58(), PAYER.publicKey.toBase58(), 21_998_600n]);
    await expect(buildFundAttestPayerTx(conn.asConnection(), wallet, wallet)).rejects.toThrow(/fresh key/);
  });
});

describe("buildAttestLaunchTx", () => {
  it("byte parity: the vector message at the vector's leaf 511 (the ledger assigned it there) gives the vector's transaction", async () => {
    const conn = vectorWorld();
    setIdentityBits(conn, []);
    const ledger = await ledgerAt511();
    const built = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { landingMarginSecs: 0n }));
    expect(built.status).toBe("ready");
    const r = built as AttestLaunchReady;
    expect(r.leaf).toBe(511);
    expect(r.leafChoice.probeStart).toBe(start());
    expect(toHex(r.message)).toBe(v.attestation.message);
    expect(r.message).toHaveLength(221);
    expect(toHex(r.messageHash)).toBe(v.attestation.messageHash);
    expect(toHex(r.metadataHash)).toBe(v.attestation.metadataHash);
    expect(r.tokenMeta.toBase58()).toBe(v.metadata.tokenMetaAccount);
    expect(toHex(r.lmsSignature)).toBe(toHex(SIG_511));
    expect(toHex(r.tx)).toBe(v.attestLaunch.v1.wire);
    expect(r.sizeBytes).toBe(3_005);
    expect(r.retry).toBe(false); // the first signature at that leaf (the record held no signature)
    expect(r.warnings).toEqual([]);
    // Absolute dates of the window (audit 4, ID-F5).
    expect(r.windowIso).toEqual({ notBefore: new Date(Number(WINDOW.notBefore) * 1000).toISOString().replace(".000Z", "Z"), notAfter: new Date(Number(WINDOW.notAfter) * 1000).toISOString().replace(".000Z", "Z") });
    // The identity exists: the payer needs the attestation's rent and the fee only.
    expect(r.fundingLamports).toBe(rent(2_708) + 5_000n);
    // Recorded before it was returned.
    const rec = await ledger.get(identity.identityId, 511);
    expect(rec?.status).toBe("signed");
    expect(rec?.signature).toBe(toHex(SIG_511));
    expect(rec?.launch).toBe(LAUNCH.toBase58());
  });

  it("audit 4, ID-F1: leaves used on-chain that this ledger never signed at (another device, or an RPC that lies) refuse BEFORE anything is reserved", async () => {
    const conn = vectorWorld();
    setIdentityBits(conn, range(PROBE, 511));
    const ledger = createMemoryLeafLedger();
    const e = await buildAttestLaunchTx(conn.asConnection(), args(ledger)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnknownLeavesError);
    expect(e).toMatchObject({ unknownCount: 511 - PROBE, usedOnChain: 511 - PROBE, knownToLedger: 0 });
    expect(await ledger.list(identity.identityId)).toEqual([]);
    // With the other device's records imported (here: the user confirmed them), the identity signs at its secret probe.
    const used = bitmapOf(range(PROBE, 511));
    await acknowledgeUnknownLeaves(ledger, identity.publicKey, used, { expectedCount: 511 - PROBE });
    const r = (await buildAttestLaunchTx(conn.asConnection(), args(ledger))) as AttestLaunchReady;
    expect(r.leaf).toBe(range(PROBE, 511).includes(start()) ? 511 : start());
  });

  it("leaves from the secret probe start reserved in the ledger for other messages are skipped", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const s = start();
    const taken = range(0, 40).map((k) => (s + k) % 1024);
    for (const q of taken) expect(await ledger.reserve(identity.identityId, q, sha256(utf8(`other ${q}`)))).toBe("reserved");
    const built = (await buildAttestLaunchTx(conn.asConnection(), args(ledger))) as AttestLaunchReady;
    expect(built.leaf).toBe((s + 40) % 1024);
    expect(lmsVerify(identity.publicKey, built.message, built.lmsSignature)).toBe((s + 40) % 1024);
    // No identity account yet: both rents.
    expect(built.fundingLamports).toBe(21_998_600n);
    for (const q of taken) expect((await ledger.get(identity.identityId, q))?.signature).toBeNull();
  });

  it("a leaf reserved for another message is never signed, even when the ledger's index of leaves is stale", async () => {
    const conn = vectorWorld();
    const real = createMemoryLeafLedger();
    const other = sha256(utf8("another message"));
    await real.reserve(identity.identityId, start(), other);
    const stale: LeafLedger = { ...real, leaves: async () => [] };
    await expect(buildAttestLaunchTx(conn.asConnection(), args(stale))).rejects.toThrow(/could not reserve a leaf/);
    const rec = await real.get(identity.identityId, start());
    expect([rec?.messageHash, rec?.signature, rec?.status]).toEqual([toHex(other), null, "reserved"]);
  });

  it("a rebuild (expired blockhash, new payer) gives the same leaf and the same signature, never a second one", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const first = (await buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: undefined }))) as AttestLaunchReady;
    expect(first.leaf).toBe(start());
    expect(lmsVerify(identity.publicKey, first.message, first.lmsSignature)).toBe(first.leaf);
    conn.blockhash = encodeBase58(sha256(utf8("later blockhash")));
    const again = (await buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: undefined }))) as AttestLaunchReady;
    expect(again.retry).toBe(true);
    expect(again.leaf).toBe(first.leaf);
    expect(toHex(again.lmsSignature)).toBe(toHex(first.lmsSignature));
    expect(again.payer.publicKey.equals(first.payer.publicKey)).toBe(false);
    expect(decodeV1Transaction(again.tx).recentBlockhash).toBe(conn.blockhash);
    expect((await ledger.list(identity.identityId)).map((r) => r.leaf)).toEqual([first.leaf]);
  });

  describe("refusals before any reservation or signature", () => {
    const refused = async (conn: AttestConnection, over: Partial<BuildAttestLaunchArgs>, why: RegExp): Promise<void> => {
      const ledger = createMemoryLeafLedger();
      await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, over))).rejects.toThrow(why);
      expect(await ledger.list(identity.identityId)).toEqual([]);
    };

    it("a wiped key pair, or an identity id that is not its key's", async () => {
      const wiped = lmsKeyPairFromTreeCache(deriveIdentityKey(fromHex(v.derivation.master), "localnet", 0), identity.keyPair.exportTreeCache());
      wiped.wipe();
      await refused(vectorWorld(), { identity: { ...identity, keyPair: wiped } }, /wiped/);
      await refused(vectorWorld(), { identity: { ...identity, keyPair: { wiped: false } } as unknown as PqIdentity }, /PqIdentity/);
      await refused(vectorWorld(), { identity: { ...identity, identityId: new Uint8Array(32).fill(1) } }, /not the id of its key pair/);
    });

    it("a metadata hash that is not 32 bytes, or a burn-only cap that is not a count", async () => {
      await refused(vectorWorld(), { metadataHash: new Uint8Array(31) }, /metadataHash must be 32 bytes/);
      await refused(vectorWorld(), { maxBurnOnlyLandings: -1 }, /maxBurnOnlyLandings/);
      await refused(vectorWorld(), { metadataCommitment: "processed" as never }, /metadataCommitment/);
    });

    it("an endpoint of another cluster (genesis hash), or localnet without the opt-in", async () => {
      const conn = vectorWorld();
      conn.genesisHash = GENESIS_HASHES.mainnet;
      await refused(conn, {}, /serves mainnet/);
      await refused(vectorWorld(), { allowLocalnet: false }, /allowLocalnet/);
    });

    it("a launch that does not exist, is not finalized, or is already live", async () => {
      await refused(vectorWorld().delete(LAUNCH), {}, /does not exist/);
      const conn = vectorWorld();
      conn.hiddenAtFinalized.add(LAUNCH.toBase58());
      await refused(conn, {}, /not finalized/);
      const ledger = createMemoryLeafLedger();
      expect((await buildAttestLaunchTx(conn.asConnection(), args(ledger, { launchCommitment: "confirmed" }))).status).toBe("ready");
      const live = fromHex(v.accounts.launch.data);
      live[13] = 1; // LaunchStatus::Live
      await refused(vectorWorld().set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: live }), {}, /already live/);
    });

    it("a launch account that is not at the PDA of its own creator and seed", async () => {
      const elsewhere = new PublicKey(sha256(utf8("not the launch PDA")));
      const conn = vectorWorld().set(elsewhere, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.launch.data) });
      await refused(conn, { launch: elsewhere }, /not at the PDA/);
    });

    it("no reviewed configuration: refused before any RPC, reservation or signature; a squatted launch PDA is never attested (review finding)", async () => {
      const { conn, squatterParamsHash } = squattedWorld();
      const ledger = createMemoryLeafLedger();
      // The hash is required: omitting it throws before anything is read or reserved.
      await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, { expectedParamsHash: undefined }))).rejects.toThrow(/expectedParamsHash is required/);
      expect(conn.calls).toEqual([]);
      expect(await ledger.list(identity.identityId)).toEqual([]);
      // With the reviewed hash, the squatter's configuration is refused.
      await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger))).rejects.toThrow(/params_hash differs/);
      expect(await ledger.list(identity.identityId)).toEqual([]);
      // Both at once is ambiguous.
      await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, { unsafeAcceptAnyParams: true }))).rejects.toThrow(/not both/);
      // Only the loudly named opt-out signs whatever the launch holds (tooling), and says so.
      const any = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { expectedParamsHash: undefined, unsafeAcceptAnyParams: true }));
      expect(any.status).toBe("ready");
      expect(toHex(parseAttestationMessage(any.message).paramsHash)).toBe(toHex(squatterParamsHash));
      expect(any.warnings.join(" ")).toMatch(/unsafeAcceptAnyParams/);
    });

    it("a launch of another creator, of another identity, or with other parameters than reviewed", async () => {
      await refused(vectorWorld(), { creator: PAYER.publicKey }, /not by this wallet/);
      const other = fromHex(v.accounts.launch.data);
      other.set(new Uint8Array(32).fill(9), 553); // pq_identity
      await refused(vectorWorld().set(LAUNCH, { owner: PROGRAM_IDS.launchpad, data: other }), {}, /another post-quantum identity/);
      await refused(vectorWorld(), { expectedParamsHash: new Uint8Array(32).fill(7) }, /params_hash differs/);
    });

    it("a metadata record that is not published (the signature would only burn its leaf), or not finalized yet (default)", async () => {
      await refused(vectorWorld().delete(RECORD), {}, /no metadata record is published at GfoSGacSrVumjGEp62ceA9M9hcEPc8mNknjueCGSqpHS/);
      // A hash whose record nobody published (another document).
      await refused(vectorWorld(), { metadataHash: fromHex(v.burnOnly.cases[3]!.metadataHash) }, /no metadata record is published/);
      // An address that only holds lamports is no record.
      await refused(vectorWorld().set(RECORD, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 9_999_999 }), {}, /no metadata record/);
      // Confirmed but not finalized: refused by default (a dropped fork would lose it), accepted when asked.
      const conn = vectorWorld();
      conn.hiddenAtFinalized.add(RECORD.toBase58());
      await refused(conn, {}, /not finalized yet/);
      expect((await buildAttestLaunchTx(conn.asConnection(), args(createMemoryLeafLedger(), { metadataCommitment: "confirmed" }))).status).toBe("ready");
    });

    it("a window that cannot open, judged against the cluster clock", async () => {
      const ms = { notBefore: WINDOW.notBefore * 1000n, notAfter: WINDOW.notAfter * 1000n };
      await refused(vectorWorld(), { window: ms }, /milliseconds/);
      await refused(vectorWorld(), { window: { notBefore: WINDOW.notBefore, notAfter: WINDOW.notBefore + 3_601n } }, /must last/);
      await refused(vectorWorld(), { window: { notBefore: LANDS_AT - 3_500n, notAfter: LANDS_AT + 100n } }, /ends before the attestation can land/);
      await refused(vectorWorld(), { window: { notBefore: LANDS_AT + 604_801n, notAfter: LANDS_AT + 604_861n } }, /7 days/);
      // The local clock does not decide: the same window after the cluster clock moved past it.
      await refused(vectorWorld().setClock(WINDOW.notAfter), {}, /ends before/);
    });

    it("a launch attested by another message whose window has not passed (it can never be replaced before that)", async () => {
      const conn = vectorWorld();
      conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.attestation.data) });
      await refused(conn, { window: { notBefore: WINDOW.notBefore + 1n, notAfter: WINDOW.notAfter } }, /already attested by another message .*whose window has not passed/);
      // At its last second it is still usable: a new window is refused too.
      conn.setClock(WINDOW.notAfter);
      await refused(conn, { window: { notBefore: WINDOW.notAfter + 600n, notAfter: WINDOW.notAfter + 4_200n } }, /whose window has not passed/);
    });
  });

  it("nothing to sign when this exact message already attested the launch", async () => {
    const conn = vectorWorld();
    conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.attestation.data) });
    const ledger = createMemoryLeafLedger();
    const r = await buildAttestLaunchTx(conn.asConnection(), args(ledger));
    expect(r.status).toBe("already-attested");
    expect(r.status === "already-attested" && r.leaf).toBe(511);
    expect("tx" in r).toBe(false);
    expect(await ledger.list(identity.identityId)).toEqual([]);
  });

  it("no re-send once the message's leaf is used on-chain: leaf-landed (then confirmAttestation)", async () => {
    const conn = vectorWorld();
    setIdentityBits(conn, []);
    const ledger = await ledgerAt511();
    expect((await buildAttestLaunchTx(conn.asConnection(), args(ledger))).status).toBe("ready");
    conn.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.identity.data) }); // leaf 511 set
    const r = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: undefined }));
    expect(r.status).toBe("leaf-landed");
    expect(r.status === "leaf-landed" && r.leaf).toBe(511);
    expect("tx" in r).toBe(false);
  });

  it("rewrapAttestTx: the same LMS signature in a new transaction (fresh blockhash, accounts derived again), never a new signature", async () => {
    const conn = vectorWorld();
    setIdentityBits(conn, []);
    const ledger = await ledgerAt511();
    const r = (await buildAttestLaunchTx(conn.asConnection(), args(ledger))) as AttestLaunchReady;
    conn.blockhash = encodeBase58(sha256(utf8("a later blockhash")));
    const again = await rewrapAttestTx(conn.asConnection(), r);
    expect(again.retry).toBe(true);
    expect(toHex(again.lmsSignature)).toBe(toHex(SIG_511));
    expect(decodeV1Transaction(again.tx).recentBlockhash).toBe(conn.blockhash);
    const a = decodeAttestArgs(decodeV1Transaction(again.tx).instructions[0]!.data);
    expect([toHex(a.lmsSig), toHex(a.metadataHash), a.notBefore, a.notAfter]).toEqual([toHex(SIG_511), v.attestation.metadataHash, WINDOW.notBefore, WINDOW.notAfter]);
    expect((await ledger.list(identity.identityId)).map((x) => [x.leaf, x.signature])).toEqual([[511, toHex(SIG_511)]]);
    // A tampered build is refused: the signature must verify at its leaf over its message.
    await expect(rewrapAttestTx(conn.asConnection(), { ...r, leaf: 510 })).rejects.toThrow(/does not verify/);
    await expect(rewrapAttestTx(conn.asConnection(), { ...r, metadataHash: new Uint8Array(32) })).rejects.toThrow(/another launch or record/);
  });

  it("rewrapAttestTx keeps the priority fee the payer was funded for (sendAttestLaunchTx re-sends without options); a new price is used only when given", async () => {
    const conn = vectorWorld();
    setIdentityBits(conn, []);
    const r = (await buildAttestLaunchTx(conn.asConnection(), args(await ledgerAt511(), { computeUnitPrice: 1_000_000n }))) as AttestLaunchReady;
    expect(r.priorityFeeLamports).toBe(300_000n);
    conn.blockhash = encodeBase58(sha256(utf8("a later blockhash")));
    const again = await rewrapAttestTx(conn.asConnection(), r);
    const d = decodeV1Transaction(again.tx);
    expect([again.priorityFeeLamports, d.priorityFeeLamports, d.computeUnitLimit, again.sizeBytes]).toEqual([300_000n, 300_000n, 300_000, r.sizeBytes]);
    const repriced = await rewrapAttestTx(conn.asConnection(), r, { computeUnitPrice: 0n });
    expect([repriced.priorityFeeLamports, decodeV1Transaction(repriced.tx).priorityFeeLamports, repriced.sizeBytes]).toEqual([null, null, r.sizeBytes - 8]);
  });
});

describe("confirmAttestation", () => {
  it("attested: version 3 holding our message hash; the ledger records the landing", async () => {
    const conn = vectorWorld();
    conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.attestation.data) });
    conn.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.identity.data) });
    const ledger = createMemoryLeafLedger();
    await ledger.reserve(identity.identityId, 511, fromHex(v.attestation.messageHash));
    await ledger.recordSignature(identity.identityId, 511, fromHex(v.attestation.message), SIG_511);
    const out = await confirmAttestation(conn.asConnection(), LAUNCH, fromHex(v.attestation.messageHash), { ledger, leaf: 511, lmsPublicKey: identity.publicKey });
    expect(out.status).toBe("attested");
    if (out.status !== "attested") return;
    expect([out.leaf, out.slot, out.ledgerUpdated, out.attestation.version]).toEqual([511, BigInt(v.accounts.attestation.slot), true, 3]);
    const rec = await ledger.get(identity.identityId, 511);
    expect([rec?.status, rec?.attested, rec?.landedSlot]).toEqual(["landed", true, String(v.accounts.attestation.slot)]);
  });

  it("another message's attestation with our leaf used: burned, already attested", async () => {
    const conn = vectorWorld();
    conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.attestation.data) });
    setIdentityBits(conn, [511, 0]);
    const ours = sha256(utf8("a message for another window"));
    const out = await confirmAttestation(conn.asConnection(), LAUNCH, ours, { leaf: 0, lmsPublicKey: identity.publicKey });
    expect(out.status).toBe("burned");
    expect(out.status === "burned" && out.reasons).toEqual(["already-attested"]);
  });

  it("burn-only landings (the vector's empty attestation): burned, with the reason of each case; the ledger is updated", async () => {
    const expected: BurnReason[][] = [
      ["record-missing"], // 11 euro signs: 33 bytes (no such record can be published)
      ["record-missing"], // empty symbol
      ["record-missing"], // a name that is not UTF-8
      ["record-missing"], // a valid record nobody published
      ["rules-missing"], // creator rules nobody published (P1c)
      ["invalid-window"], // an hour and a second
      ["invalid-window"], // closed a second before it landed
      ["invalid-window"], // opens a week and a second after it landed
      ["invalid-window"], // milliseconds
      ["wrong-identity"], // identity index 1 of the same phrase
    ];
    expect(v.burnOnly.cases).toHaveLength(expected.length);
    for (const [i, c] of v.burnOnly.cases.entries()) {
      const conn = vectorWorld();
      expect(tokenMetaAddress(LAUNCH, fromHex(c.metadataHash)).toBase58(), c.name).toBe(c.tokenMetaAccount);
      conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.burnOnly.emptyAttestation) });
      const pk = fromHex(c.publicKey);
      conn.set(identityAddress(pk), { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(pk, bitmapOf([c.q])) });
      const id = fromHex(c.identityId);
      const ledger = createMemoryLeafLedger();
      const mh = sha256(fromHex(c.message));
      await ledger.reserve(id, c.q, mh);
      if (i % 2 === 0) await ledger.recordSignature(id, c.q, fromHex(c.message), fromHex(c.signature));
      const out = await confirmAttestation(conn.asConnection(), LAUNCH, mh, { leaf: c.q, lmsPublicKey: pk, message: fromHex(c.message), landedAt: BigInt(v.burnOnly.landsAt), ledger });
      expect(out.status, c.name).toBe("burned");
      if (out.status !== "burned") continue;
      expect(out.reasons, c.name).toEqual(expected[i]);
      expect(out.attestation?.attested).toBe(false);
      expect(out.attestation?.version).toBe(0);
      expect(out.detail).toMatch(new RegExp(`leaf ${c.q} was burned without attesting`));
      expect(out.ledgerUpdated).toBe(true);
      const rec = await ledger.get(id, c.q);
      // A signed record landed (burn-only); a record that was only reserved was burned by something else.
      expect([rec?.status, rec?.attested]).toEqual(i % 2 === 0 ? ["landed", false] : ["burned", null]);
    }
  });

  it("burnReasons: the window's length only without a landing time; the record only when known", () => {
    const c = v.burnOnly.cases[6]!; // closed a second before it landed: 3,599 s long
    const base = { launchPqIdentity: fromHex(v.identity.identityId), identityId: fromHex(c.identityId), attestation: null, messageHash: sha256(fromHex(c.message)) };
    const window = { notBefore: BigInt(c.terms.notBefore), notAfter: BigInt(c.terms.notAfter) };
    expect(burnReasons({ ...base, window, landedAt: BigInt(v.burnOnly.landsAt) })).toEqual(["invalid-window"]);
    expect(burnReasons({ ...base, window })).toEqual([]);
    expect(burnReasons({ ...base, window: { notBefore: 0n, notAfter: 3_601n } })).toEqual(["invalid-window"]);
    expect(burnReasons({ ...base, launchPqIdentity: null, window })).toEqual([]);
    expect(burnReasons({ ...base, recordExists: false })).toEqual(["record-missing"]);
    expect(burnReasons({ ...base, recordExists: true })).toEqual([]);
    expect(burnReasons({ ...base, recordExists: null })).toEqual([]);
    // Audit round 3 F1: another message's attestation blocked the landing only while its window had not passed.
    const other = { attested: true, messageHash: new Uint8Array(32).fill(7), notAfter: 1_000n };
    expect(burnReasons({ ...base, attestation: other, landedAt: 1_000n })).toEqual(["already-attested"]);
    expect(burnReasons({ ...base, attestation: other, landedAt: 1_001n })).toEqual([]);
    expect(burnReasons({ ...base, attestation: other })).toEqual(["already-attested"]);
    expect(burnReasons({ ...base, attestation: { ...other, messageHash: base.messageHash }, landedAt: 1_000n })).toEqual([]);
    expect(attestationReplaceable(other, 1_000n)).toBe(false);
    expect(attestationReplaceable(other, 1_001n)).toBe(true);
    expect(attestationReplaceable({ attested: false, notAfter: 0n }, 0n)).toBe(true);
    expect(() => attestationReplaceable(other, 1_001 as unknown as bigint)).toThrow(TypeError);
    // Less than 60 s of the window left when it landed: the window could not be used.
    expect(burnReasons({ ...base, window: { notBefore: 0n, notAfter: 3_000n }, landedAt: 2_941n })).toEqual(["invalid-window"]);
    expect(burnReasons({ ...base, window: { notBefore: 0n, notAfter: 3_000n }, landedAt: 2_940n })).toEqual([]);
    // A landing time read from the chain is judged as the program judges it, never refused as "milliseconds".
    expect(burnReasons({ ...base, window, landedAt: 100_000_000_000n })).toEqual(["invalid-window"]);
    expect(burnReasons({ ...base, window: { notBefore: 100_000_000_000n, notAfter: 100_000_003_600n }, landedAt: 100_000_000_000n })).toEqual([]);
  });

  it("pending while the leaf is clear on-chain, or when the leaf and key are not given", async () => {
    const conn = vectorWorld();
    const mh = fromHex(v.attestation.messageHash);
    const a = await confirmAttestation(conn.asConnection(), LAUNCH, mh, { leaf: 511, lmsPublicKey: identity.publicKey });
    expect(a.status).toBe("pending");
    expect(a.status === "pending" && a.detail).toMatch(/has not landed/);
    setIdentityBits(conn, [3]);
    const c = await confirmAttestation(conn.asConnection(), LAUNCH, mh, { leaf: 511, lmsPublicKey: identity.publicKey });
    expect(c.status).toBe("pending");
    setIdentityBits(conn, [511]);
    const b = await confirmAttestation(conn.asConnection(), LAUNCH, mh);
    expect(b.status).toBe("pending");
    expect(b.status === "pending" && b.detail).toMatch(/pass the leaf/);
    await expect(confirmAttestation(conn.asConnection(), LAUNCH, mh, { message: fromHex(v.burnOnly.cases[0]!.message) })).rejects.toThrow(/does not hash/);
  });
});

describe("sendAttestLaunchTx (landed by a model of the program)", () => {
  async function ready(conn: AttestConnection, ledger: LeafLedger, over: ArgsOverride = {}): Promise<AttestLaunchReady> {
    const r = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: Keypair.generate(), ...over }));
    expect(r.status).toBe("ready");
    return r as AttestLaunchReady;
  }
  const fund = (conn: AttestConnection, r: AttestLaunchReady, lamports: bigint = r.fundingLamports): void => {
    conn.set(r.payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(lamports) });
  };

  it("refuses an underfunded payer, or one that would keep a non-rent-exempt remainder; sends nothing", async () => {
    const conn = vectorWorld();
    conn.land = (w) => emulateAttestLaunch(conn, w);
    const ledger = createMemoryLeafLedger();
    const r = await ready(conn, ledger);
    fund(conn, r, r.fundingLamports - 1n);
    await expect(sendAttestLaunchTx(conn.asConnection(), r, { ledger })).rejects.toBeInstanceOf(AttestPayerFundingError);
    fund(conn, r, r.fundingLamports + 1_000n);
    await expect(sendAttestLaunchTx(conn.asConnection(), r, { ledger })).rejects.toThrow(/rent-exempt minimum/);
    expect(conn.sent).toHaveLength(0);
  });

  it("funded exactly with fundingLamports: lands, attests (version 3), the ledger records it, and the payer ends at zero", async () => {
    const conn = vectorWorld();
    conn.land = (w) => emulateAttestLaunch(conn, w);
    const ledger = createMemoryLeafLedger();
    const r = await ready(conn, ledger);
    const { lamports } = await buildFundAttestPayerTx(conn.asConnection(), CREATOR, r.payer.publicKey, { launch: LAUNCH, lmsPublicKey: identity.publicKey });
    expect(lamports).toBe(r.fundingLamports);
    fund(conn, r, lamports);
    const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
    expect(out.status).toBe("attested");
    expect(out.status === "attested" && out.attestation.version).toBe(PQ_IDENTITY.ATTESTATION_VERSION);
    expect(conn.sent).toHaveLength(1);
    expect(conn.get(r.payer.publicKey)?.lamports).toBe(0);
    expect(conn.get(attestationAddress(LAUNCH))!.data).toHaveLength(2_708);
    const rec = await ledger.get(identity.identityId, r.leaf);
    expect([rec?.status, rec?.attested]).toEqual(["landed", true]);
    // A second build has nothing to sign.
    expect((await buildAttestLaunchTx(conn.asConnection(), args(ledger))).status).toBe("already-attested");
  });

  it("a send that does not land throws (re-send the same bytes); the ledger keeps the one signature", async () => {
    const conn = vectorWorld();
    conn.dropSends = true;
    const ledger = createMemoryLeafLedger();
    const r = await ready(conn, ledger);
    fund(conn, r);
    await expect(sendAttestLaunchTx(conn.asConnection(), r, { ledger })).rejects.toThrow(/did not land.*same signature bytes/s);
    expect((await ledger.get(identity.identityId, r.leaf))?.status).toBe("signed");
    conn.dropSends = false;
    conn.land = (w) => emulateAttestLaunch(conn, w);
    const again = await ready(conn, ledger);
    expect(toHex(again.lmsSignature)).toBe(toHex(r.lmsSignature));
    fund(conn, again);
    expect((await sendAttestLaunchTx(conn.asConnection(), again, { ledger })).status).toBe("attested");
  });

  /** The vector attestation (leaf 511) landed, then its window passed without a launch (audit round 3 F1). */
  function windowPassedWorld(): AttestConnection {
    const conn = vectorWorld();
    conn.land = (w) => emulateAttestLaunch(conn, w);
    conn.set(attestationAddress(LAUNCH), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.attestation.data) });
    conn.set(identityAddress(identity.publicKey), { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.identity.data) });
    return conn.setClock(WINDOW.notAfter + 1n);
  }
  /** The ledger of the device that signed the vector attestation at 511 (the leaf the identity account shows used). */
  async function signedVectorLedger(): Promise<LeafLedger> {
    const ledger = await ledgerAt511();
    expect(toHex(await reserveAndSign(ledger, identity.keyPair, 511, fromHex(v.attestation.message)))).toBe(toHex(SIG_511));
    return ledger;
  }

  it("audit round 3 F1: an attestation whose window passed unused is replaced by a new opening time, every old byte overwritten", async () => {
    const conn = windowPassedWorld();
    const ledger = await signedVectorLedger();
    const old = decodeAttestation(attestationAddress(LAUNCH), fromHex(v.accounts.attestation.data));
    const later = { notBefore: WINDOW.notAfter + 600n, notAfter: WINDOW.notAfter + 4_200n };
    const r = await ready(conn, ledger, { window: later });
    expect(r.warnings.join("\n")).toMatch(/passed without a launch: this signature replaces that attestation/);
    expect(r.fundingLamports).toBe(5_000n); // the identity and the attestation exist: the fee only
    expect(r.leaf).not.toBe(old.leaf);
    fund(conn, r);
    const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
    expect(out.status).toBe("attested");
    expect(conn.get(r.payer.publicKey)?.lamports).toBe(0);
    // The whole account is the new attestation (same launch and record, new window, leaf, message and signature).
    const expected = attestationAccountBytes({
      version: 3,
      bump: old.bump,
      launch: LAUNCH,
      pqIdentity: identity.identityId,
      leaf: r.leaf,
      metadataHash: HASH,
      messageHash: r.messageHash,
      slot: BigInt(conn.slot),
      notBefore: later.notBefore,
      notAfter: later.notAfter,
      signature: r.lmsSignature,
    });
    expect(toHex(conn.get(attestationAddress(LAUNCH))!.data)).toBe(toHex(expected));
    // A new window may also sign a new record: the message names it (here the same one, re-used).
    expect(toHex(parseAttestationMessage(r.message).metadataHash)).toBe(toHex(HASH));
    // Now the new attestation is unexpired: one more window is refused before anything is signed.
    const before = (await ledger.list(identity.identityId)).length;
    await expect(buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: Keypair.generate(), window: { notBefore: later.notBefore + 1n, notAfter: later.notAfter } }))).rejects.toThrow(
      /whose window has not passed/,
    );
    expect((await ledger.list(identity.identityId)).length).toBe(before);
  });

  it("audit round 3 F1: a replacement landing with under 60 s of its window left only burns its leaf; the old attestation stays as it was", async () => {
    const conn = windowPassedWorld();
    const ledger = await signedVectorLedger();
    const t = conn.clockNow();
    // Signed with 100 s of the window left (no landing margin), landed 41 s later: 59 s left.
    const late = { notBefore: t - 3_000n, notAfter: t + 100n };
    const r = await ready(conn, ledger, { window: late, landingMarginSecs: 0n });
    fund(conn, r);
    conn.setClock(t + 41n);
    const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
    expect(out.status).toBe("burned");
    expect(out.status === "burned" && out.reasons).toEqual(["invalid-window"]);
    expect(toHex(conn.get(attestationAddress(LAUNCH))!.data)).toBe(v.accounts.attestation.data);
    // Built with the default 300 s landing margin, the same window is refused before signing.
    await expect(buildAttestLaunchTx(conn.asConnection(), args(await signedVectorLedger(), { payer: Keypair.generate(), window: { notBefore: t + 41n - 3_000n, notAfter: t + 141n } }))).rejects.toThrow(
      /with 60 s of it left/,
    );
  });

  it("ConstraintSeeds (2006: an account the signature does not name): resent once with the SAME LMS signature, never re-signed, nothing burned", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const r = await ready(conn, ledger);
    fund(conn, r);
    // The first send is refused before anything is written (as when a relay or a wallet swapped the record account).
    let refusals = 1;
    conn.land = (w) => {
      if (refusals-- > 0) throw new ProgramError(2006, "ConstraintSeeds");
      emulateAttestLaunch(conn, w);
    };
    const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
    expect(out.status).toBe("attested");
    expect(conn.sent).toHaveLength(2);
    const sigs = conn.sent.map((w) => toHex(decodeAttestArgs(decodeV1Transaction(w).instructions[0]!.data).lmsSig));
    expect(sigs).toEqual([toHex(r.lmsSignature), toHex(r.lmsSignature)]);
    // The second transaction names the record of the signed hash.
    expect(decodeV1Transaction(conn.sent[1]!).accountKeys.some((k) => k.equals(RECORD))).toBe(true);
    expect((await ledger.list(identity.identityId)).map((x) => x.leaf)).toEqual([r.leaf]);
  });

  it("ConstraintSeeds twice: throws (nothing burned, re-send the same bytes), never a new signature", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const r = await ready(conn, ledger);
    fund(conn, r);
    conn.land = () => {
      throw new ProgramError(2006, "ConstraintSeeds");
    };
    const e = await sendAttestLaunchTx(conn.asConnection(), r, { ledger }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/refused the accounts twice \(ConstraintSeeds\): nothing was burned/);
    expect(customErrorCode(e)).toBe(2006);
    expect(conn.sent).toHaveLength(2);
    expect((await ledger.get(identity.identityId, r.leaf))?.status).toBe("signed");
  });

  it("PqLeafUsed (6041): a copy of this signature landed first (burn-only) and the identity read lags: burned, read from the attestation", async () => {
    const conn = vectorWorld();
    const ledger = createMemoryLeafLedger();
    const r = await ready(conn, ledger);
    conn.delete(RECORD); // the record was lost with a dropped fork: the copy that landed only burned the leaf
    // A relay lands the same bytes first; our own send then fails with PqLeafUsed.
    fund(conn, r);
    emulateAttestLaunch(conn, r.tx);
    fund(conn, r);
    conn.land = (w) => emulateAttestLaunch(conn, w);
    // The RPC node we read from has not seen the landing yet: the identity account is stale (missing).
    conn.staleReads.set(identityAddress(identity.publicKey).toBase58(), null);
    const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
    expect(out.status).toBe("burned");
    expect(out.status === "burned" && out.reasons).toEqual(["record-missing"]);
    const rec = await ledger.get(identity.identityId, r.leaf);
    expect([rec?.status, rec?.attested]).toEqual(["landed", false]);
  });

  it("a record lost after signing (a dropped fork): the landing only burns its leaf; republished, the same message is signed again at a new leaf, at most twice", async () => {
    const conn = vectorWorld();
    conn.land = (w) => emulateAttestLaunch(conn, w);
    const ledger = createMemoryLeafLedger();
    const leaves: number[] = [];
    for (let attempt = 0; attempt < MAX_BURN_ONLY_LANDINGS; attempt++) {
      conn.set(RECORD, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.tokenMeta.data) });
      const r = await ready(conn, ledger, { metadataCommitment: "confirmed" });
      leaves.push(r.leaf);
      expect(toHex(r.message)).toBe(v.attestation.message); // the same message every time
      conn.delete(RECORD); // the fork that held the record is dropped before the attestation lands
      fund(conn, r);
      const out = await sendAttestLaunchTx(conn.asConnection(), r, { ledger });
      expect(out.status === "burned" && out.reasons, `attempt ${attempt}`).toEqual(["record-missing"]);
    }
    expect(new Set(leaves).size).toBe(MAX_BURN_ONLY_LANDINGS); // a new leaf each time, never a second signature at one leaf
    conn.set(RECORD, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.tokenMeta.data) });
    // The cap: no third leaf for this launch, with the reasons; nothing is reserved or signed.
    const before = (await ledger.list(identity.identityId)).length;
    const e = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: Keypair.generate() })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AttestRetryLimitError);
    const err = e as AttestRetryLimitError;
    expect(err.landings.map((l) => l.leaf).sort()).toEqual([...leaves].sort());
    // The record is back now, so the cause of the past burns cannot be inferred from the chain any more.
    expect(err.reasons).toEqual([]);
    expect(err.message).toMatch(/2 landing\(s\).*only burned their leaf.*1,024 leaves/);
    expect((await ledger.list(identity.identityId)).length).toBe(before);
    // Raised deliberately, the identity signs again and the launch is attested.
    const r = await ready(conn, ledger, { maxBurnOnlyLandings: 3 });
    expect(leaves).not.toContain(r.leaf);
    fund(conn, r);
    expect((await sendAttestLaunchTx(conn.asConnection(), r, { ledger })).status).toBe("attested");
  });

  it("the cap counts every burn-only landing of the launch, whatever its message (here two windows)", async () => {
    const conn = vectorWorld();
    conn.land = (w) => emulateAttestLaunch(conn, w);
    const ledger = createMemoryLeafLedger();
    const messages = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await ready(conn, ledger, { metadataCommitment: "confirmed", window: { notBefore: WINDOW.notBefore + BigInt(attempt), notAfter: WINDOW.notAfter } });
      messages.add(toHex(r.messageHash));
      conn.delete(RECORD);
      fund(conn, r);
      expect((await sendAttestLaunchTx(conn.asConnection(), r, { ledger })).status).toBe("burned");
      conn.set(RECORD, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.tokenMeta.data) });
    }
    expect(messages.size).toBe(2);
    const e = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: Keypair.generate(), window: { notBefore: WINDOW.notBefore + 2n, notAfter: WINDOW.notAfter } })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AttestRetryLimitError);
    expect((e as AttestRetryLimitError).landings).toHaveLength(2);
    expect((e as AttestRetryLimitError).launch.equals(LAUNCH)).toBe(true);
    // Another launch's landings do not count: a 0 cap refuses even the first new leaf, a rebuild of a recorded signature is never refused.
    const fresh = createMemoryLeafLedger();
    await expect(buildAttestLaunchTx(conn.asConnection(), args(fresh, { payer: Keypair.generate(), window: { notBefore: WINDOW.notBefore + 3n, notAfter: WINDOW.notAfter }, maxBurnOnlyLandings: 0 }))).rejects.toBeInstanceOf(AttestRetryLimitError);
  });

  it("a signature that landed without attesting but was never confirmed (still 'signed', its leaf used) stays pending until confirmed (audit 4, ID-F4), then counts toward the cap; a rebuild of a recorded signature is never capped", async () => {
    const conn = vectorWorld();
    conn.land = (w) => emulateAttestLaunch(conn, w);
    const ledger = createMemoryLeafLedger();
    const r = await ready(conn, ledger, { metadataCommitment: "confirmed" });
    // A rebuild under a cap of 0 (0 burn-only landings >= 0): the recorded signature comes back, nothing new is signed.
    const again = await buildAttestLaunchTx(conn.asConnection(), args(ledger, { payer: r.payer, metadataCommitment: "confirmed", maxBurnOnlyLandings: 0 }));
    expect([again.status, again.status === "ready" && toHex(again.lmsSignature)]).toEqual(["ready", toHex(r.lmsSignature)]);
    // It lands while the record is missing (a dropped fork) and nobody confirms it: the ledger still says "signed".
    conn.delete(RECORD);
    fund(conn, r);
    conn.land(r.tx);
    expect((await ledger.get(identity.identityId, r.leaf))?.status).toBe("signed");
    conn.set(RECORD, { owner: PROGRAM_IDS.launchpad, data: fromHex(v.accounts.tokenMeta.data) });
    const next = (): ReturnType<typeof args> =>
      args(ledger, { payer: Keypair.generate(), metadataCommitment: "confirmed", window: { notBefore: WINDOW.notBefore + 1n, notAfter: WINDOW.notAfter }, maxBurnOnlyLandings: 1 });
    // Its leaf shows as used, but a bit alone never ends a pending signature (an RPC could fake it): confirm it first.
    const pending = await buildAttestLaunchTx(conn.asConnection(), next()).catch((x: unknown) => x);
    expect(pending).toBeInstanceOf(PendingAttestationError);
    expect((pending as PendingAttestationError).pending).toMatchObject([{ leaf: r.leaf, leafSetOnChain: true }]);
    expect((pending as Error).message).toMatch(/its leaf shows as used: confirm it/);
    // Confirmed from the accounts (here by confirmAttestation; landOrBurnPending does the same): one burn-only landing.
    expect((await confirmAttestation(conn.asConnection(), LAUNCH, r.messageHash, { leaf: r.leaf, lmsPublicKey: identity.publicKey, message: r.message, ledger })).status).toBe("burned");
    const e = await buildAttestLaunchTx(conn.asConnection(), next()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AttestRetryLimitError);
    expect((e as AttestRetryLimitError).landings.map((l) => l.leaf)).toEqual([r.leaf]);
  });

  it("a burn-only landing (a burn-only vector case signed through the instruction builder) is reported as burned", async () => {
    const conn = vectorWorld();
    conn.land = (w) => emulateAttestLaunch(conn, w);
    const c = v.burnOnly.cases[3]!; // a valid record nobody published
    const ix = attestLaunchInstruction({
      payer: PAYER.publicKey,
      launch: LAUNCH,
      lmsPublicKey: fromHex(c.publicKey),
      lmsSignature: fromHex(c.signature),
      metadataHash: fromHex(c.metadataHash),
      notBefore: BigInt(c.terms.notBefore),
      notAfter: BigInt(c.terms.notAfter),
    });
    expect(toHex(ix.data)).toBe(c.data);
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(c.tokenMetaAccount);
    conn.set(PAYER.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(await fundingLamportsForAttest(conn.asConnection())) });
    const signed = signAttestTransaction(PAYER, ix, conn.blockhash);
    conn.land(signed.tx);
    // What the program leaves: the vector's empty attestation, byte for byte.
    expect(toHex(conn.get(attestationAddress(LAUNCH))!.data)).toBe(v.burnOnly.emptyAttestation);
    const out = await confirmAttestation(conn.asConnection(), LAUNCH, sha256(fromHex(c.message)), { leaf: c.q, lmsPublicKey: fromHex(c.publicKey), message: fromHex(c.message), landedAt: LANDS_AT });
    expect(out.status === "burned" && out.reasons).toEqual(["record-missing"]);
    expect(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN).toBe(fromHex(v.burnOnly.emptyAttestation).length);
  });
});

/**
 * Launch builders against the mocked launch in test/world.ts: account order
 * and flags come from the IDL; these tests pin the program's remaining-account
 * conventions, optional-account placeholders, the PQ v2 accounts (payer-run
 * `launch` with its attestation, payout owners and payout-vault records,
 * `execute_batch`'s shield-ending accounts), compute budgets and sizes at
 * the largest inputs, and the deterministic refusals.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, type Transaction, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, u64le, utf8 } from "../src/codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, KNOWN_ACCOUNTS, POLICY, PROGRAM_IDS, WSOL_MINT } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { fetchLaunch, fetchLaunchByMint, listLaunches } from "../src/launch/accounts.js";
import {
  buildClaimFeesTx,
  buildClaimLpFeesTx,
  buildClaimSurplusTx,
  buildClaimTx,
  buildCommitTx,
  buildCreateLaunchTx,
  buildDistributeTx,
  buildExecuteBatchTx,
  buildLaunchCommitBundleV1,
  buildLaunchTx,
  COMPUTE_UNITS,
  LAUNCH_BUNDLE_LOADED_ACCOUNTS_BYTES,
  serializeLaunchParams,
} from "../src/launch/builders.js";
import { emulatedLaunchRulesBytes, emulatedMetadataHash, emulatedRulesHash, emulatedTokenMetaBytes, rulesPda } from "./attest_world.js";
import { PRESETS } from "../src/launch/presets.js";
import { checkFeeRecipients } from "../src/launch/recipients.js";
import {
  associatedTokenAddress,
  attestationAddress,
  certificateAddress,
  commitAddress,
  dammV2PoolAddress,
  dammV2PositionAddress,
  dammV2PositionNftAccountAddress,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  extraAccountMetaListAddress,
  hookAuthorityAddress,
  hookPolicyAddress,
  launchPdas,
  launchRulesAddress,
  payoutAddress,
  payoutVaultAddress,
  protocolAddress,
  tokenMetaAddress,
  vaultAddress,
  wsolAta,
} from "../src/pda.js";
import { decodeV1Transaction, verifyV1Signatures } from "../src/tx/v1.js";
import type { LaunchParamsInput } from "../src/types.js";
import { ext, key, readJson, T22, tokenAccountBytes } from "./helpers.js";
import { accountBytes, NOW, world, zeroed, type World } from "./world.js";

const lp = idlCodecs().launchpad;
const SPL = KNOWN_ACCOUNTS.splToken;
const LEGACY_LIMIT = 1_232;

/** A deterministic Ed25519 wallet (on the curve, like every real wallet). */
const wallet = (label: string): PublicKey => Keypair.fromSeed(sha256(utf8(label))).publicKey;

function main(tx: { instructions: TransactionInstruction[] }): TransactionInstruction {
  const ixs = tx.instructions.filter((i) => i.programId.equals(PROGRAM_IDS.launchpad));
  expect(ixs.length).toBe(1);
  return ixs[0]!;
}

type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };

/** Accounts of `ix` by IDL name, plus the remaining accounts; checks flags and fixed addresses. */
function named(ix: TransactionInstruction, name: string): { accounts: Record<string, Meta>; remaining: TransactionInstruction["keys"] } {
  const idl = lp.instruction(name);
  expect(toHex(ix.data.subarray(0, 8))).toBe(toHex(Uint8Array.from(idl.discriminator)));
  const accounts: Record<string, Meta> = {};
  idl.accounts.forEach((a, i) => {
    const k = ix.keys[i]!;
    accounts[a.name] = k;
    if (k.pubkey.equals(PROGRAM_IDS.launchpad) && a.optional === true) return;
    expect(k.isWritable, `${name}.${a.name} writable`).toBe(a.writable === true);
    expect(k.isSigner, `${name}.${a.name} signer`).toBe(a.signer === true);
    if (a.address !== undefined) expect(k.pubkey.toBase58()).toBe(a.address);
  });
  return { accounts, remaining: ix.keys.slice(idl.accounts.length) };
}

/** The ComputeBudget instructions at the start of a legacy transaction: [limit, price | null]. */
function budget(tx: Transaction): [number, bigint | null] {
  const [first, second] = tx.instructions;
  expect(first!.programId.equals(KNOWN_ACCOUNTS.computeBudget)).toBe(true);
  expect(first!.data[0]).toBe(2); // SetComputeUnitLimit
  const units = new DataView(first!.data.buffer, first!.data.byteOffset).getUint32(1, true);
  if (second === undefined || !second.programId.equals(KNOWN_ACCOUNTS.computeBudget)) return [units, null];
  expect(second.data[0]).toBe(3); // SetComputeUnitPrice
  return [units, new DataView(second.data.buffer, second.data.byteOffset).getBigUint64(1, true)];
}

const size = (tx: Transaction): number => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;

function setCommit(w: World, owner: PublicKey, amount: bigint, claimed = false, payout: { tokenOwner?: PublicKey; refundOwner?: PublicKey } = {}): void {
  const b = w.build;
  w.build = () => {
    b();
    w.conn.set(commitAddress(w.launch, owner), {
      owner: PROGRAM_IDS.launchpad,
      data: accountBytes("launchpad", "Commit", {
        version: 2,
        bump: 255,
        launch: w.launch,
        owner,
        amount,
        claimed,
        tokenOwner: payout.tokenOwner ?? owner,
        refundOwner: payout.refundOwner ?? owner,
      }),
    });
  };
  w.build();
}

/** An opened PQ vault (v4) of `mint` at its PDA, as the vault program writes it. */
function openVault(w: World, mint: PublicKey, label: string): PublicKey {
  const keyId = sha256(utf8(label));
  const vault = vaultAddress(mint, keyId);
  w.conn.set(vault, {
    owner: PROGRAM_IDS.vault,
    data: accountBytes("vault", "Vault", {
      version: 4,
      bump: 255,
      mint,
      genesisKeyId: keyId,
      sequence: 0n,
      keyId,
      keyIdent: new Uint8Array(16),
      keyQ: 0,
      keyK: new Uint8Array(32),
      reserved: 0n,
    }),
  });
  return vault;
}

/** SPL Token `CloseAccount` of the owner's wSOL ATA: every lamport to the owner, signed by the owner. */
function expectCloseWsol(ix: TransactionInstruction, owner: PublicKey): void {
  expect(ix.programId.equals(SPL)).toBe(true);
  expect([...ix.data]).toEqual([9]);
  expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
    [wsolAta(owner).toBase58(), false, true],
    [owner.toBase58(), false, true],
    [owner.toBase58(), true, false],
  ]);
}

const hookKeys = (w: World): string[] =>
  [extraAccountMetaListAddress(w.mint), hookPolicyAddress(w.mint), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook].map((k) => k.toBase58());

/** The P1c vectors (tests/integration/vectors/programmable.json): real PXR1 rule sets (typical 286 B, largest 1,228 B). */
const PROG = readJson<{ launch: { address: string }; rules: { name: string; bytes: string; rulesHash: string; address: string; len: number }[] }>("./vectors/programmable.json");

const programs = (tx: { instructions: TransactionInstruction[] }): string[] => tx.instructions.filter((i) => !i.programId.equals(KNOWN_ACCOUNTS.computeBudget)).map((i) => i.programId.toBase58());

describe("reads", () => {
  it("fetchLaunch / fetchLaunchByMint / listLaunches decode the launch with its market snapshot", async () => {
    const w = world();
    const l = await fetchLaunch(w.conn.asConnection(), w.launch);
    expect(l?.status).toBe("live");
    expect(l?.market).toMatchObject({ name: "Verified", symbol: "VER", curveComplete: false, migrated: false, hookActive: true, initialSupply: 1_000_000_000_000_000n });
    expect(toHex(l!.pqIdentity)).toBe(toHex(w.launchState["pqIdentity"] as Uint8Array));
    expect((await fetchLaunchByMint(w.conn.asConnection(), w.mint))?.publicKey.equals(w.launch)).toBe(true);
    expect(await fetchLaunchByMint(w.conn.asConnection(), key("nobody"))).toBeNull();
    const all = await listLaunches(w.conn.asConnection());
    expect(all.map((x) => x.publicKey.toBase58())).toEqual([w.launch.toBase58()]);
    expect(all[0]!.market?.quoteReserve).toBe(20_000_000_000n);
  });
});

// --------------------------------------------------------------- create ---

describe("create_launch", () => {
  const creator = wallet("builders/creator");
  const params = (): LaunchParamsInput => ({
    ...PRESETS.fair.params,
    recipients: [{ wallet: wallet("builders/r"), bps: 10_000 }],
    pqIdentity: sha256(utf8("builders/identity")),
  });

  it("seeds [\"launch\", creator, seed], args with pq_identity last, a tight compute limit and an optional priority fee", async () => {
    const w = world();
    const seed = new Uint8Array(32).fill(4);
    const { tx, launch, launchSeed } = await buildCreateLaunchTx(w.conn.asConnection(), creator, params(), { launchSeed: seed });
    const p = launchPdas(creator, seed);
    expect(launch.equals(p.launch)).toBe(true);
    // Another creator with the same seed gets another launch (no squatting).
    expect(launchPdas(wallet("builders/other"), seed).launch.equals(launch)).toBe(false);
    expect(launchSeed).toEqual(seed);
    const ix = main(tx);
    const { accounts } = named(ix, "create_launch");
    expect(accounts["creator"]!.pubkey.equals(creator)).toBe(true);
    expect(accounts["launch"]!.pubkey.equals(p.launch)).toBe(true);
    expect(accounts["protocol"]!.pubkey.equals(protocolAddress())).toBe(true);
    expect(accounts["launch_authority"]!.pubkey.equals(p.launchAuthority)).toBe(true);
    expect(accounts["dbc_config"]!.pubkey.equals(p.dbcConfig)).toBe(true);
    const data = serializeLaunchParams(params());
    expect(toHex(data.subarray(data.length - 32))).toBe(toHex(params().pqIdentity));
    expect(toHex(ix.data)).toBe(toHex(concatBytes([Uint8Array.from(lp.instruction("create_launch").discriminator), seed, data])));
    expect(tx.feePayer?.equals(creator)).toBe(true);
    expect(budget(tx)).toEqual([COMPUTE_UNITS.createLaunch, null]);
    const priced = await buildCreateLaunchTx(w.conn.asConnection(), creator, params(), { launchSeed: seed, computeUnitPrice: 50_000n, computeUnitLimit: 90_000 });
    expect(budget(priced.tx)).toEqual([90_000, 50_000n]);
    // A random seed is drawn when none is given.
    const r = await buildCreateLaunchTx(w.conn.asConnection(), creator, params());
    expect(r.launchSeed.length).toBe(32);
    expect(r.launch.equals(launchPdas(creator, r.launchSeed).launch)).toBe(true);
  });

  it("refuses what the program refuses: own PDAs as recipients, bad windows, a zero identity, no protocol", async () => {
    const w = world();
    const seed = new Uint8Array(32).fill(4);
    const p = launchPdas(creator, seed);
    const bad = params();
    bad.recipients = [{ wallet: p.launchAuthority, bps: 10_000 }];
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, bad, { launchSeed: seed })).rejects.toThrow(/own program addresses/);
    const invalid = params();
    invalid.openDelaySecs = 59;
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, invalid)).rejects.toThrow(/openDelaySecs/);
    const noIdentity = params();
    noIdentity.pqIdentity = new Uint8Array(32);
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, noIdentity)).rejects.toThrow(/pqIdentity/);
    const dust = params();
    dust.batchTotalCap = 1n;
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, dust)).rejects.toThrow(/batchTotalCap/);
    w.conn.set(p.launch, { owner: PROGRAM_IDS.launchpad, data: new Uint8Array(8) });
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, params(), { launchSeed: seed })).rejects.toThrow(/already exists/);
    w.conn.delete(protocolAddress());
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, params())).rejects.toThrow(/protocol/);
  });

  it("fee recipients may be wSOL PQ vaults; owners whose ATA nobody could move are refused (A8)", async () => {
    const w = world();
    const withRecipient = (r: PublicKey): LaunchParamsInput => ({ ...params(), recipients: [{ wallet: r, bps: 10_000 }] });
    const wsolVault = openVault(w, WSOL_MINT, "fees/wsol");
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(wsolVault))).resolves.toBeDefined();
    // A wallet that never held anything (no account) is fine.
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(wallet("fees/fresh")))).resolves.toBeDefined();
    // A vault of another mint only releases that mint: its wSOL ATA would be stuck.
    const baseVault = openVault(w, w.mint, "fees/base");
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(baseVault))).rejects.toThrow(/recipients\[0\]\.wallet: a PQ vault of another mint/);
    // Another vault-program account (a payout).
    const payout = payoutAddress(wsolVault, 0n);
    w.conn.set(payout, { owner: PROGRAM_IDS.vault, data: new Uint8Array(122) });
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(payout))).rejects.toThrow(/not a vault/);
    // A token account as "wallet".
    const tokenAccount = wallet("fees/token-account");
    w.conn.set(tokenAccount, { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: creator, amount: 0n }) });
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(tokenAccount))).rejects.toThrow(/token account or mint/);
    // An off-curve address with no account: an unopened vault, a closed account, a mistyped PDA.
    const unopened = vaultAddress(WSOL_MINT, sha256(utf8("fees/unopened")));
    expect(PublicKey.isOnCurve(unopened.toBytes())).toBe(false);
    await expect(buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(unopened))).rejects.toThrow(/off-curve address with no account/);
    // A program wallet (a multisig's system-owned vault PDA): accepted, with a warning.
    const multisig = PublicKey.findProgramAddressSync([utf8("multisig"), utf8("vault")], key("builders/multisig-program"))[0];
    w.conn.set(multisig, { owner: KNOWN_ACCOUNTS.system, data: new Uint8Array(0), lamports: 1_000_000 });
    const ok = await buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(multisig));
    expect(ok.warnings.join()).toMatch(/recipients\[0\]\.wallet: an off-curve account of the system program/);
    expect((await buildCreateLaunchTx(w.conn.asConnection(), creator, withRecipient(wsolVault))).warnings).toEqual([]);
  });

  it("checkFeeRecipients (audit round 3 F3): what a wizard checks per recipient, the same answers buildCreateLaunchTx gives", async () => {
    const w = world();
    const c = w.conn.asConnection();
    const wsolVault = openVault(w, WSOL_MINT, "f3/wsol");
    const baseVault = openVault(w, w.mint, "f3/base");
    const multisig = PublicKey.findProgramAddressSync([utf8("multisig"), utf8("vault")], key("f3/multisig-program"))[0];
    w.conn.set(multisig, { owner: KNOWN_ACCOUNTS.system, data: new Uint8Array(0), lamports: 1_000_000 });
    const r = await checkFeeRecipients(c, [{ wallet: wallet("f3/fresh") }, { wallet: wsolVault }, { wallet: baseVault }, { wallet: multisig }]);
    // distribute pays the recipient's wSOL ATA: a vault of another mint never releases wSOL, so its share would be lost.
    expect(r.ok).toBe(false);
    expect(r.refusals).toEqual([`recipients[2].wallet: a PQ vault of another mint (${w.mint.toBase58()}): a vault only releases its own mint, so these tokens would be stuck forever`]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^recipients\[3\]\.wallet: an off-curve account of the system program/);
    const fine = await checkFeeRecipients(c, [{ wallet: wsolVault }, { wallet: wallet("f3/fresh") }]);
    expect(fine).toEqual({ ok: true, refusals: [], warnings: [] });
    // Accounts already fetched are used as given (in order): a wSOL vault's bytes passed for the base vault's address pass.
    const pre = await checkFeeRecipients(c, [{ wallet: baseVault }], [{ address: baseVault, owner: PROGRAM_IDS.vault, lamports: 1, executable: false, data: w.conn.get(wsolVault)!.data }]);
    expect(pre.ok).toBe(true);
    await expect(checkFeeRecipients(c, [{ wallet: "not a key" as unknown as PublicKey }])).rejects.toThrow(TypeError);
  });

  it("the largest params the policy accepts fit a legacy transaction with both compute-budget instructions", async () => {
    const w = world();
    const p = params();
    // MAX_CURVE_POINTS points spread over the preset's price range, 4 recipients, a dynamic fee, pq_identity.
    const start = p.sqrtStartPrice;
    const end = p.curve[p.curve.length - 1]!.sqrtPrice;
    const liquidity = p.curve[0]!.liquidity;
    const n = BigInt(POLICY.MAX_CURVE_POINTS);
    p.curve = Array.from({ length: POLICY.MAX_CURVE_POINTS }, (_, i) => ({ sqrtPrice: start + ((end - start) * BigInt(i + 1)) / n, liquidity }));
    p.recipients = [1, 2, 3, 4].map((i) => ({ wallet: wallet(`builders/recipient-${i}`), bps: 2_500 }));
    expect(p.dynamicFee).not.toBeNull();
    const { tx } = await buildCreateLaunchTx(w.conn.asConnection(), creator, p, { launchSeed: new Uint8Array(32).fill(5), computeUnitPrice: (1n << 64n) - 1n });
    expect(budget(tx)[1]).toBe((1n << 64n) - 1n);
    expect(size(tx)).toBeLessThanOrEqual(LEGACY_LIMIT);
    // Measured on SBF: 1,107 B with both instructions.
    expect(size(tx)).toBeGreaterThan(1_050);
  });
});

// --------------------------------------------------------------- launch ---

/** A metadata record as bytes (the test's own model of the program hashes and stores them). */
interface Rec {
  name: Uint8Array;
  symbol: Uint8Array;
  flags: number;
  uri: Uint8Array;
  doc: Uint8Array;
}
const rec = (name: string, symbol: string, flags = 0, uri = "", doc = ""): Rec => ({ name: utf8(name), symbol: utf8(symbol), flags, uri: utf8(uri), doc: utf8(doc) });
const META = rec("Verified", "VER");
const recordHash = (r: Rec): Uint8Array => emulatedMetadataHash(r.name, r.symbol, r.flags, r.uri, r.doc);
const recordAt = (launch: PublicKey, r: Rec): PublicKey => PublicKey.findProgramAddressSync([utf8("metadata"), launch.toBytes(), recordHash(r)], PROGRAM_IDS.launchpad)[0];

/** A Configured launch of `w` with an attestation (version 2) over the record `meta` (published unless told) and the window `[nb, na]`. */
function attested(w: World, meta: Rec = META, nb = BigInt(NOW - 10), na = BigInt(NOW + 3_590), version = 3, published = true, rules: Uint8Array | null = null, rulesPublished = true): void {
  w.launchState["status"] = { kind: "Configured" };
  const identity = w.launchState["pqIdentity"] as Uint8Array;
  const b = w.build;
  w.build = () => {
    b();
    w.conn.set(attestationAddress(w.launch), {
      owner: PROGRAM_IDS.launchpad,
      data: accountBytes("launchpad", "Attestation", {
        version,
        bump: 254,
        launch: version === 3 ? w.launch : PublicKey.default,
        pqIdentity: version === 3 ? identity : new Uint8Array(32),
        leaf: 7,
        metadataHash: version === 3 ? recordHash(meta) : new Uint8Array(32),
        rulesHash: version === 3 && rules !== null ? emulatedRulesHash(rules) : new Uint8Array(32),
        messageHash: new Uint8Array(32).fill(9),
        slot: 399_000_000n,
        notBefore: version === 3 ? nb : 0n,
        notAfter: version === 3 ? na : 0n,
        signature: version === 3 ? new Uint8Array(2_508).fill(1) : new Uint8Array(0),
      }),
    });
    if (published) w.conn.set(recordAt(w.launch, meta), { owner: PROGRAM_IDS.launchpad, data: emulatedTokenMetaBytes(w.launch, meta.name, meta.symbol, meta.flags, meta.uri, meta.doc) });
    if (rules !== null && rulesPublished) w.conn.set(rulesPda(w.launch, emulatedRulesHash(rules))[0], { owner: PROGRAM_IDS.launchpad, data: emulatedLaunchRulesBytes(w.launch, rules) });
  };
  w.build();
}

describe("launch (permissionless inside the attested window; no arguments)", () => {
  it("account 0 is any payer; the attestation, the record it names and, last, the rules account are passed; no data but the discriminator; no creator signature", async () => {
    const w = world();
    attested(w);
    const keeper = wallet("builders/keeper");
    expect(keeper.equals(w.launchState["creator"] as PublicKey)).toBe(false);
    const mintKp = Keypair.generate();
    const { tx } = await buildLaunchTx(w.conn.asConnection(), keeper, w.launch, mintKp);
    const ix = main(tx);
    const { accounts } = named(ix, "launch");
    expect(ix.keys).toHaveLength(23);
    expect(toHex(ix.data)).toBe("99f15de116454a3d");
    // No creator rules (zero rules hash): the launchpad program id in place of the rules record (P1c).
    expect(ix.keys[22]).toEqual({ pubkey: PROGRAM_IDS.launchpad, isSigner: false, isWritable: false });
    expect(accounts["payer"]).toEqual({ pubkey: keeper, isSigner: true, isWritable: true });
    expect(accounts["attestation"]!.pubkey.equals(attestationAddress(w.launch))).toBe(true);
    expect(ix.keys[20]!.pubkey.equals(attestationAddress(w.launch))).toBe(true);
    expect(ix.keys[21]).toEqual({ pubkey: recordAt(w.launch, META), isSigner: false, isWritable: false });
    expect(accounts["token_meta"]!.pubkey.equals(tokenMetaAddress(w.launch, recordHash(META)))).toBe(true);
    const pool = dbcPoolAddress(w.dbcConfig, mintKp.publicKey, WSOL_MINT);
    expect(accounts["pool"]!.pubkey.equals(pool)).toBe(true);
    expect(accounts["base_vault"]!.pubkey.equals(dbcTokenVaultAddress(mintKp.publicKey, pool))).toBe(true);
    expect(accounts["quote_vault"]!.pubkey.equals(dbcTokenVaultAddress(WSOL_MINT, pool))).toBe(true);
    expect(accounts["certificate"]!.pubkey.equals(certificateAddress(mintKp.publicKey))).toBe(true);
    expect(accounts["policy"]!.pubkey.equals(hookPolicyAddress(mintKp.publicKey))).toBe(true);
    expect(accounts["extra_account_meta_list"]!.pubkey.equals(extraAccountMetaListAddress(mintKp.publicKey))).toBe(true);
    // Signers: the payer and the fresh mint only.
    expect(tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map((k) => k.toBase58()).sort()).toEqual([keeper, mintKp.publicKey].map((k) => k.toBase58()).sort());
    expect(tx.signatures.find((s) => s.publicKey.equals(mintKp.publicKey))?.signature).not.toBeNull();
    expect(budget(tx)).toEqual([COMPUTE_UNITS.launch, null]);
    expect(COMPUTE_UNITS.launch).toBe(300_000);
  });

  it("refuses outside notBefore..=notAfter (NotLaunchWindow, cluster clock), inclusive at both ends", async () => {
    const at = async (nb: bigint, na: bigint): Promise<unknown> => {
      const w = world();
      attested(w, META, nb, na);
      return buildLaunchTx(w.conn.asConnection(), wallet("k"), w.launch, Keypair.generate());
    };
    const now = BigInt(NOW);
    await expect(at(now + 1n, now + 3_600n)).rejects.toThrow(/NotLaunchWindow/);
    await expect(at(now - 3_600n, now - 1n)).rejects.toThrow(/NotLaunchWindow/);
    await expect(at(now, now + 60n)).resolves.toBeDefined();
    await expect(at(now - 60n, now)).resolves.toBeDefined();
    // An explicit time overrides the cluster clock.
    const w = world();
    attested(w, META, now + 100n, now + 200n);
    await expect(buildLaunchTx(w.conn.asConnection(), wallet("k"), w.launch, Keypair.generate(), { nowSecs: now + 100n })).resolves.toBeDefined();
    await expect(buildLaunchTx(w.conn.asConnection(), wallet("k"), w.launch, Keypair.generate(), { nowSecs: now + 201n })).rejects.toThrow(/NotLaunchWindow/);
    // One type for now: a number (or milliseconds) is refused before anything is read.
    const reads = w.conn.calls.length;
    await expect(buildLaunchTx(w.conn.asConnection(), wallet("k"), w.launch, Keypair.generate(), { nowSecs: Number(now + 100n) as unknown as bigint })).rejects.toThrow(TypeError);
    await expect(buildLaunchTx(w.conn.asConnection(), wallet("k"), w.launch, Keypair.generate(), { nowSecs: (now + 100n) * 1000n })).rejects.toThrow(/milliseconds/);
    expect(w.conn.calls.length).toBe(reads);
  });

  it("refuses a missing or empty attestation, a missing record, another identity, a launched launch and a used mint address", async () => {
    const payer = wallet("k");
    const none = world();
    none.launchState["status"] = { kind: "Configured" };
    none.build();
    await expect(buildLaunchTx(none.conn.asConnection(), payer, none.launch, Keypair.generate())).rejects.toThrow(/not attested yet/);
    const empty = world();
    attested(empty, META, 0n, 0n, 0);
    await expect(buildLaunchTx(empty.conn.asConnection(), payer, empty.launch, Keypair.generate())).rejects.toThrow(/empty/);
    const unpublished = world();
    attested(unpublished, META, BigInt(NOW - 10), BigInt(NOW + 3_590), 3, false);
    await expect(buildLaunchTx(unpublished.conn.asConnection(), payer, unpublished.launch, Keypair.generate())).rejects.toThrow(/record the attestation names does not exist \(AccountNotInitialized\)/);
    const wrongIdentity = world();
    attested(wrongIdentity);
    wrongIdentity.launchState["pqIdentity"] = new Uint8Array(32).fill(3);
    wrongIdentity.build();
    await expect(buildLaunchTx(wrongIdentity.conn.asConnection(), payer, wrongIdentity.launch, Keypair.generate())).rejects.toThrow(/AttestationMismatch/);
    const live = world();
    await expect(buildLaunchTx(live.conn.asConnection(), payer, live.launch, Keypair.generate())).rejects.toThrow(/already been launched/);
    const other = world();
    attested(other);
    const used = Keypair.generate();
    other.conn.set(used.publicKey, { owner: T22, data: new Uint8Array(82) });
    await expect(buildLaunchTx(other.conn.asConnection(), payer, other.launch, used)).rejects.toThrow(/fresh/);
  });

  it("is the same 988 B legacy transaction for every record, with both compute-budget instructions (1,020 B with creator rules)", async () => {
    const sizes = new Set<number>();
    for (const meta of [META, rec("N".repeat(32), "S".repeat(10), 2, `https://${"u".repeat(192)}`, "d".repeat(3_072)), rec("€€€€€€€€€€NN", "€UR", 1, "", "{}")]) {
      const w = world();
      attested(w, meta);
      const { tx } = await buildLaunchTx(w.conn.asConnection(), wallet("builders/keeper"), w.launch, Keypair.generate(), { computeUnitPrice: (1n << 64n) - 1n });
      expect(budget(tx)).toEqual([COMPUTE_UNITS.launch, (1n << 64n) - 1n]);
      sizes.add(size(tx));
    }
    expect([...sizes]).toEqual([988]);
    expect(988).toBeLessThanOrEqual(LEGACY_LIMIT);
    // With rules, whatever their size (the record travels as an account, +32 B): 1,020 B, the largest record and rule set included.
    const withRules = new Set<number>();
    for (const r of PROG.rules) {
      const w = world();
      attested(w, rec("N".repeat(32), "S".repeat(10), 2, `https://${"u".repeat(192)}`, "d".repeat(3_072)), BigInt(NOW - 10), BigInt(NOW + 3_590), 3, true, fromHex(r.bytes));
      const { tx } = await buildLaunchTx(w.conn.asConnection(), wallet("builders/keeper"), w.launch, Keypair.generate(), { computeUnitPrice: (1n << 64n) - 1n });
      withRules.add(size(tx));
    }
    expect([...withRules]).toEqual([1_020]);
    expect(1_020).toBeLessThanOrEqual(LEGACY_LIMIT);
  });

  it("P1c: the 23rd account is the attested rules record exactly when the attestation's rules hash is not zero; a missing record is refused", async () => {
    const rules = fromHex(PROG.rules[0]!.bytes);
    const w = world();
    attested(w, META, BigInt(NOW - 10), BigInt(NOW + 3_590), 3, true, rules);
    const ix = main((await buildLaunchTx(w.conn.asConnection(), wallet("k"), w.launch, Keypair.generate())).tx);
    expect(ix.keys).toHaveLength(23);
    expect(ix.keys[22]).toEqual({ pubkey: launchRulesAddress(w.launch, emulatedRulesHash(rules)), isSigner: false, isWritable: false });
    expect(ix.keys[22]!.pubkey.equals(rulesPda(w.launch, emulatedRulesHash(rules))[0])).toBe(true);
    // The vector record's address for the vector launch.
    expect(launchRulesAddress(new PublicKey(PROG.launch.address), fromHex(PROG.rules[0]!.rulesHash)).toBase58()).toBe(PROG.rules[0]!.address);
    // A rules hash whose record nobody published: launch would fail (AccountNotInitialized); refused before building.
    const missing = world();
    attested(missing, META, BigInt(NOW - 10), BigInt(NOW + 3_590), 3, true, rules, false);
    await expect(buildLaunchTx(missing.conn.asConnection(), wallet("k"), missing.launch, Keypair.generate())).rejects.toThrow(/rules record the attestation names does not exist/);
  });
});

describe("[launch, commit] v1 bundle", () => {
  it("one signed v1 transaction: launch, wrap, commit, close; priority fee and limit as config words", async () => {
    const w = world();
    attested(w);
    const payer = Keypair.fromSeed(sha256(utf8("builders/bundle-payer")));
    const mintKp = Keypair.generate();
    const r = await buildLaunchCommitBundleV1(w.conn.asConnection(), payer, w.launch, mintKp, 2_000_000_000n, { computeUnitPrice: 1_000_000n });
    const d = decodeV1Transaction(r.tx);
    expect(r.tx.length).toBeLessThanOrEqual(4_096);
    expect(verifyV1Signatures(d)).toBe(true);
    expect(d.header.numRequiredSignatures).toBe(2);
    expect(d.accountKeys[0]!.equals(payer.publicKey)).toBe(true);
    expect(d.accountKeys.slice(0, 2).some((k) => k.equals(mintKp.publicKey))).toBe(true);
    expect(d.instructions.map((i) => d.accountKeys[i.programIdIndex]!.toBase58())).toEqual(
      [PROGRAM_IDS.launchpad, KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.system, SPL, PROGRAM_IDS.launchpad, SPL].map((k) => k.toBase58()),
    );
    expect(toHex(d.instructions[0]!.data)).toBe(toHex(Uint8Array.from(lp.instruction("launch").discriminator)));
    expect(d.accountKeys[d.instructions[0]!.accounts[21]!]!.equals(recordAt(w.launch, META))).toBe(true);
    const commit = d.instructions[4]!;
    expect(toHex(commit.data)).toBe(toHex(concatBytes([Uint8Array.from(lp.instruction("commit").discriminator), u64le(2_000_000_000n)])));
    const commitKeys = commit.accounts.map((i) => d.accountKeys[i]!.toBase58());
    expect(commitKeys[0]).toBe(payer.publicKey.toBase58());
    expect(commitKeys.at(-1)).toBe(PROGRAM_IDS.launchpad.toBase58()); // payout_vault: None (tokens to the payer)
    expect(d.computeUnitLimit).toBe(COMPUTE_UNITS.launchCommitBundle);
    expect(COMPUTE_UNITS.launchCommitBundle).toBe(COMPUTE_UNITS.launch + COMPUTE_UNITS.commit);
    expect(d.loadedAccountsDataSizeLimit).toBe(LAUNCH_BUNDLE_LOADED_ACCOUNTS_BYTES);
    expect(d.priorityFeeLamports).toBe(BigInt(COMPUTE_UNITS.launchCommitBundle)); // 1,000,000 micro-lamports (1 lamport) per unit
    expect(r.priorityFeeLamports).toBe(BigInt(COMPUTE_UNITS.launchCommitBundle));
    expect(r.signature).not.toBe("");
    // No price: no priority-fee config word.
    const plain = decodeV1Transaction((await buildLaunchCommitBundleV1(w.conn.asConnection(), payer, w.launch, Keypair.generate(), 1n)).tx);
    expect(plain.priorityFeeLamports).toBeNull();
    // Same refusals as launch, and the per-wallet cap.
    await expect(buildLaunchCommitBundleV1(w.conn.asConnection(), payer, w.launch, Keypair.generate(), (w.launchState["batchWalletCap"] as bigint) + 1n)).rejects.toThrow(/per-wallet/);
    await expect(buildLaunchCommitBundleV1(w.conn.asConnection(), payer, w.launch, Keypair.generate(), 1n, { nowSecs: BigInt(NOW + 3_591) })).rejects.toThrow(/NotLaunchWindow/);
    await expect(buildLaunchCommitBundleV1(w.conn.asConnection(), payer, w.launch, Keypair.generate(), 1n, { refundOwner: wallet("x") })).rejects.toThrow(/InvalidPayoutOwner/);
  });
});

// ---------------------------------------------------------------- batch ---

describe("commit", () => {
  const live = (): World => {
    const w = world();
    w.launchState["executed"] = false;
    w.build();
    return w;
  };

  it("wraps SOL and commits for the committer (payout_vault = None); only the caps refuse", async () => {
    const w = live();
    const owner = wallet("builders/owner");
    const tx = await buildCommitTx(w.conn.asConnection(), owner, w.launch, 1_000_000_000n);
    // Create the wSOL ATA, wrap, commit, then close the (now empty) wSOL account this transaction created.
    expect(programs(tx)).toEqual([KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.system, SPL, PROGRAM_IDS.launchpad, SPL].map((k) => k.toBase58()));
    expectCloseWsol(tx.instructions.at(-1)!, owner);
    const { accounts } = named(main(tx), "commit");
    expect(accounts["commit"]!.pubkey.equals(commitAddress(w.launch, owner))).toBe(true);
    expect(accounts["owner_quote_account"]!.pubkey.equals(wsolAta(owner))).toBe(true);
    expect(accounts["batch_quote_escrow"]!.pubkey.equals(wsolAta(w.batchAuthority))).toBe(true);
    expect(accounts["token_owner"]).toEqual({ pubkey: owner, isSigner: false, isWritable: false });
    expect(accounts["refund_owner"]).toEqual({ pubkey: owner, isSigner: false, isWritable: false });
    expect(accounts["payout_vault"]).toEqual({ pubkey: PROGRAM_IDS.launchpad, isSigner: false, isWritable: false });
    expect(toHex(main(tx).data.subarray(8))).toBe(toHex(u64le(1_000_000_000n)));
    expect(budget(tx)).toEqual([COMPUTE_UNITS.commit, null]);

    setCommit(w, owner, 4_500_000_000n);
    await expect(buildCommitTx(w.conn.asConnection(), owner, w.launch, 600_000_000n)).rejects.toThrow(/per-wallet/);
    // The total cap never refuses: an oversubscribed batch is filled pro rata.
    w.launchState["totalCommitted"] = w.launchState["batchTotalCap"];
    w.build();
    const over = await buildCommitTx(w.conn.asConnection(), wallet("x"), w.launch, 1_000_000_000n);
    expect(toHex(main(over).data.subarray(8))).toBe(toHex(u64le(1_000_000_000n)));
    w.launchState["totalCommitted"] = (1n << 64n) - 1n;
    w.build();
    await expect(buildCommitTx(w.conn.asConnection(), wallet("x"), w.launch, 1n)).rejects.toThrow(/overflow/);
    await expect(buildCommitTx(w.conn.asConnection(), owner, w.launch, 0n)).rejects.toThrow(/positive/);
    const done = world();
    await expect(buildCommitTx(done.conn.asConnection(), owner, done.launch, 1n)).rejects.toThrow(/already executed/);
  });

  it("commits into PQ vaults: token owner a vault of the base mint (payout_vault PDA), refund owner a wSOL vault", async () => {
    const w = live();
    const owner = wallet("builders/vault-committer");
    const baseVault = openVault(w, w.mint, "commit/base");
    const wsolVault = openVault(w, WSOL_MINT, "commit/wsol");
    const tx = await buildCommitTx(w.conn.asConnection(), owner, w.launch, 1_000_000_000n, { tokenOwner: baseVault, refundOwner: wsolVault, computeUnitPrice: 7n });
    const { accounts } = named(main(tx), "commit");
    expect(accounts["token_owner"]!.pubkey.equals(baseVault)).toBe(true);
    expect(accounts["refund_owner"]!.pubkey.equals(wsolVault)).toBe(true);
    expect(accounts["payout_vault"]).toEqual({ pubkey: payoutVaultAddress(w.launch, baseVault), isSigner: false, isWritable: true });
    expect(accounts["owner"]).toEqual({ pubkey: owner, isSigner: true, isWritable: true });
    expect(budget(tx)).toEqual([COMPUTE_UNITS.commit, 7n]);
    expect(size(tx)).toBeLessThanOrEqual(LEGACY_LIMIT);
    // Only the refund in a vault: the tokens go to the committer, no payout-vault record.
    const refundOnly = named(main(await buildCommitTx(w.conn.asConnection(), owner, w.launch, 1n, { refundOwner: wsolVault })), "commit").accounts;
    expect(refundOnly["payout_vault"]!.pubkey.equals(PROGRAM_IDS.launchpad)).toBe(true);
  });

  it("refuses payout owners the program refuses (InvalidPayoutOwner) and holds a vault's commits to one wallet's cap (CapExceeded)", async () => {
    const w = live();
    const owner = wallet("builders/vault-committer");
    const baseVault = openVault(w, w.mint, "commit/base");
    const wsolVault = openVault(w, WSOL_MINT, "commit/wsol");
    const c = w.conn.asConnection();
    await expect(buildCommitTx(c, owner, w.launch, 1n, { tokenOwner: wallet("someone") })).rejects.toThrow(/InvalidPayoutOwner/);
    await expect(buildCommitTx(c, owner, w.launch, 1n, { tokenOwner: wsolVault })).rejects.toThrow(/InvalidPayoutOwner/);
    await expect(buildCommitTx(c, owner, w.launch, 1n, { refundOwner: baseVault })).rejects.toThrow(/InvalidPayoutOwner/);
    // The record adds up every commit naming the vault, by anyone.
    const cap = w.launchState["batchWalletCap"] as bigint;
    w.conn.set(payoutVaultAddress(w.launch, baseVault), {
      owner: PROGRAM_IDS.launchpad,
      data: accountBytes("launchpad", "PayoutVault", { version: 1, bump: 250, launch: w.launch, vault: baseVault, committed: cap - 1n }),
    });
    await expect(buildCommitTx(c, owner, w.launch, 2n, { tokenOwner: baseVault })).rejects.toThrow(/CapExceeded/);
    await expect(buildCommitTx(c, owner, w.launch, 1n, { tokenOwner: baseVault })).resolves.toBeDefined();
    // A record of another launch at that address is refused.
    w.conn.set(payoutVaultAddress(w.launch, baseVault), {
      owner: PROGRAM_IDS.launchpad,
      data: accountBytes("launchpad", "PayoutVault", { version: 1, bump: 250, launch: key("other-launch"), vault: baseVault, committed: 0n }),
    });
    await expect(buildCommitTx(c, owner, w.launch, 1n, { tokenOwner: baseVault })).rejects.toThrow(/another launch/);
  });

  it("an existing commit's payout owners are fixed: later commits default to them and refuse others", async () => {
    const w = live();
    const owner = wallet("builders/repeat");
    const baseVault = openVault(w, w.mint, "commit/base");
    setCommit(w, owner, 1n, false, { tokenOwner: baseVault });
    const again = named(main(await buildCommitTx(w.conn.asConnection(), owner, w.launch, 1n)), "commit").accounts;
    expect(again["token_owner"]!.pubkey.equals(baseVault)).toBe(true);
    expect(again["payout_vault"]!.pubkey.equals(payoutVaultAddress(w.launch, baseVault))).toBe(true);
    await expect(buildCommitTx(w.conn.asConnection(), owner, w.launch, 1n, { tokenOwner: owner })).rejects.toThrow(/fixed/);
    await expect(buildCommitTx(w.conn.asConnection(), owner, w.launch, 1n, { refundOwner: openVault(w, WSOL_MINT, "w") })).rejects.toThrow(/fixed/);
  });

  it("closes the temporary wSOL account only when the transaction creates it (L5)", async () => {
    const w = live();
    const owner = wallet("builders/wsol-holder");
    // An existing wSOL account (it may hold wSOL the owner keeps) is used and left as it is.
    w.conn.set(wsolAta(owner), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner, amount: 5_000n }) });
    const tx = await buildCommitTx(w.conn.asConnection(), owner, w.launch, 1_000_000_000n);
    expect(programs(tx)).toEqual([KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.system, SPL, PROGRAM_IDS.launchpad].map((k) => k.toBase58()));
    // Only lamports at the address (no account data yet): the transaction creates the account, so it closes it.
    w.conn.set(wsolAta(owner), { owner: KNOWN_ACCOUNTS.system, data: new Uint8Array(0), lamports: 7 });
    expectCloseWsol((await buildCommitTx(w.conn.asConnection(), owner, w.launch, 1_000_000_000n)).instructions.at(-1)!, owner);
  });
});

describe("execute_batch", () => {
  it("named accounts end the shield (hook_authority, writable policy, hook program); remaining are exactly the four hook accounts", async () => {
    const w = world();
    w.launchState["executed"] = false;
    w.build();
    const payer = wallet("builders/cranker");
    const tx = await buildExecuteBatchTx(w.conn.asConnection(), payer, w.launch, { computeUnitPrice: 1_000n });
    expect(budget(tx)).toEqual([COMPUTE_UNITS.executeBatch, 1_000n]);
    const { accounts, remaining } = named(main(tx), "execute_batch");
    expect(accounts["hook_authority"]).toEqual({ pubkey: hookAuthorityAddress(), isSigner: false, isWritable: false });
    expect(accounts["policy"]).toEqual({ pubkey: hookPolicyAddress(w.mint), isSigner: false, isWritable: true });
    expect(accounts["hook_program"]!.pubkey.equals(PROGRAM_IDS.hook)).toBe(true);
    expect(remaining.map((r) => r.pubkey.toBase58())).toEqual(hookKeys(w));
    expect(remaining.every((r) => !r.isSigner && !r.isWritable)).toBe(true);
    expect(accounts["batch_base_escrow"]!.pubkey.equals(associatedTokenAddress(w.batchAuthority, w.mint, T22))).toBe(true);
    expect(accounts["base_vault"]!.pubkey.equals(dbcTokenVaultAddress(w.mint, w.pool))).toBe(true);
    expect(main(tx).data.length).toBe(8);
    expect(size(tx)).toBeLessThanOrEqual(LEGACY_LIMIT);

    const done = world();
    await expect(buildExecuteBatchTx(done.conn.asConnection(), payer, done.launch)).rejects.toThrow(/already executed/);
    // The batch must be the pool's first trade (PoolAlreadyTraded).
    const traded = world();
    traded.launchState["executed"] = false;
    (traded.poolState["poolState"] as Record<string, unknown>)["hasSwap"] = 1;
    traded.build();
    await expect(buildExecuteBatchTx(traded.conn.asConnection(), payer, traded.launch)).rejects.toThrow(/PoolAlreadyTraded/);
    const empty = world();
    empty.launchState["executed"] = false;
    empty.launchState["totalCommitted"] = 0n;
    empty.build();
    await expect(buildExecuteBatchTx(empty.conn.asConnection(), payer, empty.launch)).rejects.toThrow(/nothing was committed/);
  });
});

describe("claim", () => {
  it("after execution: tokens + refund to the commit's payout owners' ATAs; hook accounts only while the hook is active", async () => {
    const w = world();
    const owner = wallet("builders/claimer");
    setCommit(w, owner, 1_000_000_000n);
    const payer = wallet("builders/payer");
    const tx = await buildClaimTx(w.conn.asConnection(), payer, w.launch, owner);
    expect(budget(tx)).toEqual([COMPUTE_UNITS.claim, null]);
    const { accounts, remaining } = named(main(tx), "claim");
    expect(accounts["batch_base_escrow"]!.pubkey.equals(associatedTokenAddress(w.batchAuthority, w.mint, T22))).toBe(true);
    expect(accounts["token_owner"]!.pubkey.equals(owner)).toBe(true);
    expect(accounts["refund_owner"]!.pubkey.equals(owner)).toBe(true);
    expect(accounts["token_owner_ata"]!.pubkey.equals(associatedTokenAddress(owner, w.mint, T22))).toBe(true);
    expect(accounts["refund_owner_ata"]!.pubkey.equals(wsolAta(owner))).toBe(true);
    expect(remaining.map((r) => r.pubkey.toBase58())).toEqual(hookKeys(w));
    expect(toHex(main(tx).data.subarray(8))).toBe(toHex(owner.toBytes()));

    w.mintOpts.extensions[1] = ext.transferHook(null, null); // graduated: hook revoked
    w.build();
    const after = named(main(await buildClaimTx(w.conn.asConnection(), payer, w.launch, owner)), "claim");
    expect(after.remaining).toEqual([]);
  });

  it("into PQ vaults: the vaults' own token accounts, never a close; fits a legacy transaction with both budget instructions", async () => {
    const w = world();
    const owner = wallet("builders/vault-claimer");
    const baseVault = openVault(w, w.mint, "claim/base");
    const wsolVault = openVault(w, WSOL_MINT, "claim/wsol");
    setCommit(w, owner, 1_000_000_000n, false, { tokenOwner: baseVault, refundOwner: wsolVault });
    const tx = await buildClaimTx(w.conn.asConnection(), owner, w.launch, owner, { computeUnitPrice: (1n << 64n) - 1n });
    const { accounts, remaining } = named(main(tx), "claim");
    expect(accounts["token_owner"]!.pubkey.equals(baseVault)).toBe(true);
    expect(accounts["refund_owner"]!.pubkey.equals(wsolVault)).toBe(true);
    expect(accounts["token_owner_ata"]!.pubkey.equals(associatedTokenAddress(baseVault, w.mint, T22))).toBe(true);
    expect(accounts["refund_owner_ata"]!.pubkey.equals(wsolAta(wsolVault))).toBe(true);
    expect(remaining.length).toBe(4);
    // The owner cannot close a vault's account: no close even though the owner pays.
    expect(programs(tx)).toEqual([PROGRAM_IDS.launchpad.toBase58()]);
    expect(size(tx)).toBeLessThanOrEqual(LEGACY_LIMIT);
  });

  it("after expiry: full refund, base accounts are the program-id placeholder", async () => {
    const w = world();
    Object.assign(w.launchState, { executed: false, quoteSpent: 0n, tokensOut: 0n });
    const owner = wallet("builders/refund");
    setCommit(w, owner, 7n);
    const { accounts, remaining } = named(main(await buildClaimTx(w.conn.asConnection(), owner, w.launch, owner)), "claim");
    for (const optional of ["batch_base_escrow", "token_owner_ata"]) {
      expect(accounts[optional]).toEqual({ pubkey: PROGRAM_IDS.launchpad, isSigner: false, isWritable: false });
    }
    expect(accounts["refund_owner_ata"]!.pubkey.equals(wsolAta(owner))).toBe(true);
    expect(remaining).toEqual([]);
  });

  it("the refund owner claiming for itself closes the wSOL account the claim creates (L5); never an existing one, never for another payer", async () => {
    const w = world();
    const owner = wallet("builders/self-claim");
    setCommit(w, owner, 1_000_000_000n);
    // Executed batch with a refund: claim, then close the wSOL account the claim created (the refund arrives as SOL).
    const own = await buildClaimTx(w.conn.asConnection(), owner, w.launch, owner);
    expect(programs(own)).toEqual([PROGRAM_IDS.launchpad, SPL].map((k) => k.toBase58()));
    expectCloseWsol(own.instructions.at(-1)!, owner);
    // A third-party payer cannot close the owner's account.
    expect(programs(await buildClaimTx(w.conn.asConnection(), wallet("builders/cranker"), w.launch, owner))).toEqual([PROGRAM_IDS.launchpad.toBase58()]);
    // An existing wSOL account receives the refund and stays.
    w.conn.set(wsolAta(owner), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner, amount: 0n }) });
    expect(programs(await buildClaimTx(w.conn.asConnection(), owner, w.launch, owner))).toEqual([PROGRAM_IDS.launchpad.toBase58()]);
    w.conn.delete(wsolAta(owner));
    // No refund (the batch spent everything): no wSOL account is involved.
    w.launchState["quoteSpent"] = w.launchState["totalCommitted"];
    w.build();
    expect(programs(await buildClaimTx(w.conn.asConnection(), owner, w.launch, owner))).toEqual([PROGRAM_IDS.launchpad.toBase58()]);
    // Expired batch: the full refund arrives as SOL too.
    const expired = world();
    Object.assign(expired.launchState, { executed: false, quoteSpent: 0n, tokensOut: 0n });
    setCommit(expired, owner, 7n);
    expectCloseWsol((await buildClaimTx(expired.conn.asConnection(), owner, expired.launch, owner)).instructions.at(-1)!, owner);
  });

  it("refusals", async () => {
    const w = world();
    const owner = wallet("builders/claimed");
    await expect(buildClaimTx(w.conn.asConnection(), owner, w.launch, owner)).rejects.toThrow(/no commit/);
    setCommit(w, owner, 5n, true);
    await expect(buildClaimTx(w.conn.asConnection(), owner, w.launch, owner)).rejects.toThrow(/already been claimed/);
  });
});

// ----------------------------------------------------------------- fees ---

describe("fees", () => {
  it("claim_fees / claim_surplus use the launch authority's ATAs", async () => {
    const w = world();
    const payer = wallet("builders/fees");
    const feesTx = await buildClaimFeesTx(w.conn.asConnection(), payer, w.launch, { computeUnitPrice: 5n });
    expect(budget(feesTx)).toEqual([COMPUTE_UNITS.claimFees, 5n]);
    const fees = named(main(feesTx), "claim_fees").accounts;
    expect(fees["authority_quote_ata"]!.pubkey.equals(wsolAta(w.launchAuthority))).toBe(true);
    expect(fees["authority_base_ata"]!.pubkey.equals(associatedTokenAddress(w.launchAuthority, w.mint, T22))).toBe(true);
    expect(fees["launch_authority"]!.pubkey.equals(w.launchAuthority)).toBe(true);
    const surplus = named(main(await buildClaimSurplusTx(w.conn.asConnection(), payer, w.launch)), "claim_surplus").accounts;
    expect(surplus["quote_vault"]!.pubkey.equals(dbcTokenVaultAddress(WSOL_MINT, w.pool))).toBe(true);
  });

  it("distribute: [wallet_i, wSOL ATA_i] per stored recipient, in order; a vault recipient is paid into its own token account", async () => {
    const w = world();
    const vault = openVault(w, WSOL_MINT, "distribute/vault");
    const recipients = [
      { wallet: vault, bps: 2_500 },
      { wallet: wallet("d/2"), bps: 2_500 },
      { wallet: wallet("d/3"), bps: 2_500 },
      { wallet: wallet("d/4"), bps: 2_500 },
    ];
    Object.assign(w.launchState, { recipients, recipientCount: 4 });
    w.build();
    const tx = await buildDistributeTx(w.conn.asConnection(), wallet("builders/d"), w.launch, { computeUnitPrice: (1n << 64n) - 1n });
    const { accounts, remaining } = named(main(tx), "distribute");
    expect(remaining.map((m) => [m.pubkey.toBase58(), m.isWritable])).toEqual(recipients.flatMap((x) => [[x.wallet.toBase58(), false], [wsolAta(x.wallet).toBase58(), true]]));
    expect(remaining[1]!.pubkey.equals(associatedTokenAddress(vault, WSOL_MINT, SPL))).toBe(true);
    expect(accounts["treasury_quote_ata"]!.pubkey.equals(wsolAta(w.launchState["treasury"] as PublicKey))).toBe(true);
    expect(budget(tx)).toEqual([COMPUTE_UNITS.distribute, (1n << 64n) - 1n]);
    expect(size(tx)).toBeLessThanOrEqual(LEGACY_LIMIT);
  });

  it("claim_lp_fees: one transaction per launch-authority position with fees, the others skipped; none -> refused", async () => {
    const w = world();
    await expect(buildClaimLpFeesTx(w.conn.asConnection(), wallet("p"), w.launch)).rejects.toThrow(/no launch-authority LP position/);
    const pool = dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, w.mint, WSOL_MINT);
    const poolState = zeroed("dammV2", "Pool");
    Object.assign(poolState, { tokenAMint: w.mint, tokenBMint: WSOL_MINT, tokenAVault: key("va"), tokenBVault: key("vb"), creator: KNOWN_ACCOUNTS.dbcPoolAuthority });
    const positions: Record<string, Record<string, unknown>> = {};
    const nfts = [key("builders/nft-1"), key("builders/nft-2"), key("builders/nft-3")];
    const set = (): void => {
      w.conn.set(pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", poolState) });
      for (const nft of nfts) {
        const position = positions[nft.toBase58()] ?? Object.assign(zeroed("dammV2", "Position"), { pool, nftMint: nft, permanentLockedLiquidity: 1n << 70n });
        positions[nft.toBase58()] = position;
        w.conn.set(dammV2PositionAddress(nft), { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Position", position) });
        w.conn.set(dammV2PositionNftAccountAddress(nft), { owner: T22, data: tokenAccountBytes({ mint: nft, owner: w.launchAuthority, amount: 1n, token2022: true }) });
      }
    };
    set();
    await expect(buildClaimLpFeesTx(w.conn.asConnection(), wallet("p"), w.launch)).rejects.toThrow(/no launch-authority LP position/);
    // Fees accrued in the pool since the checkpoints: (liquidity * delta) >> 128 for every position ...
    const perLiquidity = new Uint8Array(32);
    perLiquidity[16] = 1; // 2^128 as U256 little-endian
    poolState["feeBPerLiquidity"] = perLiquidity;
    // ... except the second, whose checkpoint is already there (nothing claimable).
    positions[nfts[1]!.toBase58()]!["feeBPerTokenCheckpoint"] = perLiquidity;
    set();
    const txs = await buildClaimLpFeesTx(w.conn.asConnection(), wallet("p"), w.launch, { computeUnitPrice: 3n });
    expect(txs.length).toBe(2);
    const claimed = txs.map((tx) => {
      expect(budget(tx)).toEqual([COMPUTE_UNITS.claimLpFees, 3n]);
      expect(size(tx)).toBeLessThanOrEqual(LEGACY_LIMIT);
      const { accounts } = named(main(tx), "claim_lp_fees");
      expect(accounts["damm_pool"]!.pubkey.equals(pool)).toBe(true);
      expect(accounts["token_a_vault"]!.pubkey.equals(key("va"))).toBe(true);
      return accounts["position"]!.pubkey.toBase58();
    });
    expect(claimed.sort()).toEqual([nfts[0]!, nfts[2]!].map((n) => dammV2PositionAddress(n).toBase58()).sort());
    const first = named(main(txs.find((t) => named(main(t), "claim_lp_fees").accounts["position"]!.pubkey.equals(dammV2PositionAddress(nfts[0]!)))!), "claim_lp_fees").accounts;
    expect(first["position_nft_account"]!.pubkey.equals(dammV2PositionNftAccountAddress(nfts[0]!))).toBe(true);
  });
});

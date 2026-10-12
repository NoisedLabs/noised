/**
 * Every instruction the simulated-chain backend builds matches the program
 * IDLs: Anchor discriminator, account order, signer and writable flags, and
 * fixed addresses. The IDLs are the SDK's (generated with `anchor idl build`
 * from programs/, plus the vendored MIT-licensed Meteora IDLs), so the mock's
 * transaction reviews show what production transactions contain. (The live
 * backend's builders are the SDK's, tested in sdk/test.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { IDLS } from "@noisedlabs/sdk";
import { Connection, Keypair, TransactionInstruction, type PublicKey, type Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { beforeEach, describe, expect, it } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { errorCode } from "../src/lib/mock/common";
import { mockSignDeterministic } from "../src/lib/mock/lmotsSigner";
import { seedState } from "../src/lib/mock/fixtures";
import { replaceStateForTests, state } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import type * as T from "../src/lib/noised";

const phx = { ...adapter, ...mock };

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
}
interface Idl {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[];
  errors?: { code: number; name: string; msg: string }[];
}

const ALL: Record<string, Idl> = Object.fromEntries(Object.entries(IDLS).map(([k, v]) => [k, v as unknown as Idl]));

const conn = new Connection("http://127.0.0.1:8899");

/** The launchpad instruction of a transaction (the SDK puts the compute-budget instructions first). */
function launchpadIx(tx: Transaction): TransactionInstruction | undefined {
  return tx.instructions.find((ix) => ix.programId.equals(adapter.PROGRAM_IDS.launchpad));
}

/** Check one instruction against its IDL entry; returns the instruction name. */
function checkIx(ix: TransactionInstruction): string {
  const idl = Object.values(ALL).find((i) => i.address === ix.programId.toBase58());
  if (!idl) throw new Error(`no IDL for program ${ix.programId.toBase58()}`);
  const disc = Array.from(ix.data.subarray(0, 8));
  const def = idl.instructions.find((d) => d.discriminator.every((b, i) => b === disc[i]));
  if (!def) throw new Error(`unknown discriminator ${disc.join(",")} for ${idl.address}`);
  expect(ix.keys.length, `${def.name}: account count`).toBeGreaterThanOrEqual(def.accounts.length);
  def.accounts.forEach((a, i) => {
    const meta = ix.keys[i];
    if (!meta) throw new Error(`${def.name}: missing account ${a.name}`);
    // Anchor encodes an omitted optional account as the program id.
    if (a.optional === true && meta.pubkey.equals(ix.programId)) {
      expect(meta.isWritable, `${def.name}.${a.name} (None)`).toBe(false);
      return;
    }
    expect(meta.isSigner, `${def.name}.${a.name} signer`).toBe(a.signer === true);
    expect(meta.isWritable, `${def.name}.${a.name} writable`).toBe(a.writable === true);
    if (a.address !== undefined) expect(meta.pubkey.toBase58(), `${def.name}.${a.name} address`).toBe(a.address);
  });
  return def.name;
}

/** All Anchor instructions of a transaction for known programs (skips System/Token/ATA helpers). */
function programIxs(tx: Transaction): string[] {
  const known = new Set(Object.values(ALL).map((i) => i.address));
  return tx.instructions.filter((ix) => known.has(ix.programId.toBase58())).map(checkIx);
}

async function launchBySymbol(symbol: string): Promise<T.LaunchAccount> {
  const l = (await phx.listLaunches(conn)).find((x) => x.market?.symbol === symbol);
  if (!l) throw new Error(`fixture ${symbol} missing`);
  return l;
}

let user: PublicKey;
beforeEach(() => {
  replaceStateForTests(seedState());
  user = Keypair.generate().publicKey;
  phx.fundDemoWallet(user);
});

describe("launchpad instructions match the IDL", () => {
  it("create_launch and launch", async () => {
    const params: T.LaunchParamsInput = { ...phx.PRESETS.fair.params, recipients: [{ wallet: user, bps: 10_000 }], pqIdentity: new Uint8Array(32).fill(7) };
    const created = await phx.buildCreateLaunchTx(conn, user, params);
    expect(programIxs(created.tx)).toEqual(["create_launch"]);
    const configured = (await phx.listLaunches(conn)).find((l) => l.status === "configured");
    if (!configured) throw new Error("no configured fixture");
    // Permissionless inside the attested window: any payer, no arguments.
    const { tx } = await phx.buildLaunchTx(conn, user, configured.publicKey, Keypair.generate());
    expect(programIxs(tx)).toEqual(["launch"]);
    // Its last account (22nd) is the metadata record the attestation names, read-only: the mint's name and symbol come from it.
    const attestation = await phx.fetchAttestation(conn, configured.publicKey);
    if (!attestation) throw new Error("no attestation");
    const ix = launchpadIx(tx);
    // SDK 0.7 (P1c): 23 accounts; the 23rd is the attested rules record, or the launchpad program id without rules.
    expect(ix?.keys).toHaveLength(23);
    expect(ix?.keys[21]).toEqual({ pubkey: phx.tokenMetaAddress(configured.publicKey, attestation.metadataHash), isSigner: false, isWritable: false });
    expect(ix?.keys[22]).toEqual({ pubkey: phx.PROGRAM_IDS.launchpad, isSigner: false, isWritable: false });
  });

  it("commit, execute_batch and claim (executed and expired)", async () => {
    const aegis = await launchBySymbol("AEGS");
    expect(programIxs(await phx.buildCommitTx(conn, user, aegis.publicKey, 1n))).toEqual(["commit"]);
    expect(programIxs(await phx.buildExecuteBatchTx(conn, user, aegis.publicKey))).toEqual(["execute_batch"]);
    const bastion = await launchBySymbol("BSTN");
    expect(programIxs(await phx.buildClaimTx(conn, user, bastion.publicKey, user))).toEqual(["claim"]);
    const ember = await launchBySymbol("EMBR");
    expect(programIxs(await phx.buildClaimTx(conn, user, ember.publicKey, user))).toEqual(["claim"]);
  });

  it("execute_batch and claim pass the four hook accounts in the launchpad's canonical order", async () => {
    const aegis = await launchBySymbol("AEGS");
    const ix = launchpadIx(await phx.buildExecuteBatchTx(conn, user, aegis.publicKey));
    if (!ix) throw new Error("no instruction");
    const canonical = [phx.extraAccountMetaListAddress(aegis.baseMint), phx.hookPolicyAddress(aegis.baseMint), phx.KNOWN_ACCOUNTS.sysvarInstructions, phx.PROGRAM_IDS.hook].map((k) => k.toBase58());
    expect(ix.keys.slice(-4).map((k) => k.pubkey.toBase58())).toEqual(canonical);
    expect(ix.keys.slice(-4).every((k) => !k.isSigner && !k.isWritable)).toBe(true);
    // A claim that pays tokens while the hook is active carries the same four.
    const lantern = await launchBySymbol("LNTN");
    const owner = Keypair.generate().publicKey;
    state().commits[`${lantern.publicKey.toBase58()}:${owner.toBase58()}`] = {
      publicKey: phx.commitAddress(lantern.publicKey, owner),
      version: 1,
      bump: 255,
      launch: lantern.publicKey,
      owner,
      amount: 1_000_000_000n,
      claimed: false,
      tokenOwner: owner,
      refundOwner: owner,
    };
    const claim = launchpadIx(await phx.buildClaimTx(conn, user, lantern.publicKey, owner));
    expect(claim?.keys.slice(-4).map((k) => k.pubkey.toBase58())).toEqual(
      [phx.extraAccountMetaListAddress(lantern.baseMint), phx.hookPolicyAddress(lantern.baseMint), phx.KNOWN_ACCOUNTS.sysvarInstructions, phx.PROGRAM_IDS.hook].map((k) => k.toBase58()),
    );
  });

  it("a claim passes only the optional accounts its payout needs", async () => {
    const ember = await launchBySymbol("EMBR");
    // Expired batch: a full wSOL refund, no tokens, so no base escrow, no base ATA and no hook accounts.
    const ix = launchpadIx(await phx.buildClaimTx(conn, user, ember.publicKey, user));
    if (!ix) throw new Error("no instruction");
    expect(programIxs(await phx.buildClaimTx(conn, user, ember.publicKey, user))).toEqual(["claim"]);
    const names = (ALL.launchpad?.instructions.find((i) => i.name === "claim")?.accounts ?? []).map((a) => a.name);
    const at = (name: string): string | undefined => ix.keys[names.indexOf(name)]?.pubkey.toBase58();
    expect(at("batch_base_escrow")).toBe(phx.PROGRAM_IDS.launchpad.toBase58());
    expect(at("token_owner_ata")).toBe(phx.PROGRAM_IDS.launchpad.toBase58());
    expect(at("refund_owner_ata")).toBe(phx.associatedTokenAddress(user, phx.WSOL_MINT, phx.KNOWN_ACCOUNTS.splToken).toBase58());
    expect(ix.keys).toHaveLength(names.length);
  });

  it("claim_fees, claim_lp_fees and distribute", async () => {
    const lantern = await launchBySymbol("LNTN");
    expect(programIxs(await phx.buildClaimFeesTx(conn, user, lantern.publicKey))).toEqual(["claim_fees"]);
    const meridian = await launchBySymbol("MRDN");
    // One transaction per position with fees.
    expect((await phx.buildClaimLpFeesTx(conn, user, meridian.publicKey)).map(programIxs)).toEqual([["claim_lp_fees"]]);
    const dist = await phx.buildDistributeTx(conn, user, lantern.publicKey);
    expect(programIxs(dist)).toEqual(["distribute"]);
    // Remaining accounts: [wallet_i, wsol_ata_i] per stored recipient.
    const ix = launchpadIx(dist);
    expect(ix?.keys.length).toBe(13 + 2 * lantern.recipientCount);
  });
});

describe("Meteora swaps match the vendored Meteora IDLs", () => {
  it("DBC swap2_with_transfer_hook while the hook is active, DAMM v2 swap2 after graduation", async () => {
    const lantern = await launchBySymbol("LNTN");
    const buy = (await phx.buildSwapTx(conn, user, lantern.baseMint, "buy", 1_000_000n, 100)).tx;
    expect(programIxs(buy)).toEqual(["swap2_with_transfer_hook"]);
    // The Launch Guard's four accounts, in the launchpad's canonical order (the SDK's canonicalizeLaunchGuardAccounts).
    const swap = buy.instructions.find((ix) => ix.programId.equals(phx.PROGRAM_IDS.dbc));
    expect(swap?.keys.slice(-4).map((k) => k.pubkey.toBase58())).toEqual(
      [phx.extraAccountMetaListAddress(lantern.baseMint), phx.hookPolicyAddress(lantern.baseMint), phx.KNOWN_ACCOUNTS.sysvarInstructions, phx.PROGRAM_IDS.hook].map((k) => k.toBase58()),
    );
    expect(programIxs((await phx.buildSwapTx(conn, user, lantern.baseMint, "sell", 1_000_000n, 100)).tx)).toEqual(["swap2_with_transfer_hook"]);
    const meridian = await launchBySymbol("MRDN");
    expect(programIxs((await phx.buildSwapTx(conn, user, meridian.baseMint, "buy", 1_000_000n, 100)).tx)).toEqual(["swap2"]);
  });
});

describe("vault and shield instructions match the IDL", () => {
  it("open_vault (legacy), withdraw and withdraw + release (v1), release and release_to (legacy)", async () => {
    const meridian = await launchBySymbol("MRDN");
    const mint = meridian.baseMint;
    const master = phx.masterFromPhrase(phx.generateRecoveryPhrase());
    const k0 = phx.deriveVaultKey(master, "devnet", mint, 0, 0);
    const k1 = phx.deriveVaultKey(master, "devnet", mint, 0, 1);
    const open = await phx.buildOpenVaultTx(conn, user, mint, k0.pk);
    expect(programIxs(open)).toEqual(["open_vault"]);
    expect((await phx.simulateAndExplain(conn, open)).ok).toBe(true);
    await phx.sendAndConfirm(conn, open);
    const vault = phx.vaultAddress(mint, k0.keyId);
    await phx.sendAndConfirm(conn, await phx.buildDepositTx(conn, user, mint, vault, 10n));
    const msg = phx.withdrawMessage(vault, mint, 0n, user, 1n, k1.keyId);
    const args = { mint, vault, sequence: 0n, destinationOwner: user, maxAmount: 1n, signature: mockSignDeterministic(k0.skSeed, k0.pk, msg), nextKey: k1.pk, nextKeyId: k1.keyId };
    const feePayer = Keypair.generate();

    /** The instructions of a v1 transaction with their signer / writable flags rebuilt from the header. */
    const v1Ixs = (tx: Uint8Array): TransactionInstruction[] => {
      const d = phx.decodeV1Transaction(tx);
      const n = d.accountKeys.length;
      const { numRequiredSignatures: sig, numReadonlySigned: ros, numReadonlyUnsigned: rou } = d.header;
      return d.instructions.map(
        (ix) =>
          new TransactionInstruction({
            programId: d.accountKeys[ix.programIdIndex] as PublicKey,
            keys: ix.accounts.map((i) => ({ pubkey: d.accountKeys[i] as PublicKey, isSigner: i < sig, isWritable: i < sig ? i < sig - ros : i < n - rou })),
            data: Buffer.from(ix.data),
          }),
      );
    };
    // Alone, the withdraw's flags are exactly the IDL's (its vault token account read-only).
    const alone = await phx.buildWithdrawTx(conn, feePayer, args);
    expect(v1Ixs(alone.tx).map(checkIx)).toEqual(["withdraw"]);
    // With release in the same transaction: the program's account order for both instructions.
    const both = v1Ixs((await phx.buildWithdrawTx(conn, feePayer, { ...args, includeRelease: true })).tx);
    const idlNames = (name: string): string[] => (ALL.vault?.instructions.find((i) => i.name === name)?.accounts ?? []).map((a) => a.name);
    expect(both.map((ix) => Array.from(ix.data.subarray(0, 8)))).toEqual(
      ["withdraw", "release"].map((name) => ALL.vault?.instructions.find((i) => i.name === name)?.discriminator),
    );
    expect(both[1]?.keys.length).toBe(idlNames("release").length);
    expect(both[1]?.keys[idlNames("release").indexOf("rent_payer")]?.pubkey.equals(feePayer.publicKey)).toBe(true);
    expect(both[1]?.keys[idlNames("release").indexOf("memo_program")]?.pubkey.equals(phx.KNOWN_ACCOUNTS.memo)).toBe(true);

    // A pending payout: release (anyone) and release_to (the recipient).
    await phx.sendAndConfirm(conn, await phx.buildFundFeePayerTx(conn, user, feePayer.publicKey, phx.FEE_PAYER_FUNDING_LAMPORTS));
    await phx.sendAndConfirm(conn, alone.tx);
    expect(programIxs(await phx.buildReleaseTx(conn, user, { vault, mint, sequence: 0n }))).toEqual(["release"]);
    const destination = phx.associatedTokenAddress(user, mint, phx.KNOWN_ACCOUNTS.token2022);
    expect(programIxs(await phx.buildReleaseToTx(conn, user, { vault, mint, sequence: 0n, destination }))).toEqual(["release_to"]);
  });

  it("create_shield, wrap and unwrap", async () => {
    const lantern = await launchBySymbol("LNTN");
    expect(programIxs(await phx.buildCreateShieldTx(conn, user, lantern.baseMint))).toEqual(["create_shield"]);
    const meridian = await launchBySymbol("MRDN");
    expect(programIxs(await phx.buildWrapTx(conn, user, meridian.baseMint, 1n))).toEqual(["wrap"]);
    expect(programIxs(await phx.buildUnwrapTx(conn, user, meridian.baseMint, 1n))).toEqual(["unwrap"]);
  });
});

describe("the mock's simulated failures are real program errors", () => {
  it("every error name the mock raises exists in that program's IDL", () => {
    const dir = fileURLToPath(new URL("../src/lib/mock/", import.meta.url));
    const sources = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    const used: [program: "launchpad" | "vault" | "shield" | "hook", name: string][] = [];
    for (const [fn, program] of [["launchFail", "launchpad"], ["vaultFail", "vault"], ["shieldFail", "shield"]] as const) {
      for (const m of sources.matchAll(new RegExp(`${fn}\\("(\\w+)"\\)`, "g"))) used.push([program, m[1] ?? ""]);
    }
    for (const name of ["SnipeShield", "TransfersLocked", "MaxBuy", "MaxWallet"]) used.push(["hook", name]);
    expect(used.length).toBeGreaterThan(15);
    for (const [program, name] of used) {
      const code = errorCode(program, name);
      expect(ALL[program]?.errors?.find((e) => e.code === code)?.name, `${program}.${name}`).toBe(name);
    }
  });
});

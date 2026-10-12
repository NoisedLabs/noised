/**
 * Launch payouts into a PQ vault, against the simulated chain (it mirrors
 * the SDK 0.3.0 builders): a commit can name the committer's opened vault
 * of the launch's token as its token owner (fixed by the first commit),
 * everything committed for one vault is held to the per-wallet cap together
 * (`fetchPayoutVault` is what the token page shows as the vault's room),
 * the claim pays the vault's own token account, and a buy can pay the vault
 * (`buildSwapTx` recipient). Liquidity fees are claimed one transaction per
 * position (`buildClaimLpFeesTx` returns a list).
 */
import { PQ_VAULT_LAYOUT } from "@noisedlabs/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { seedState } from "../src/lib/mock/fixtures";
import { replaceStateForTests } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import type * as T from "../src/lib/noised";

const phx = { ...adapter, ...mock };
const conn = new Connection("http://127.0.0.1:8899");
const SOL = 1_000_000_000n;
const now = (): number => Math.floor(Date.now() / 1000);

function demoUser(): PublicKey {
  const user = Keypair.generate().publicKey;
  phx.fundDemoWallet(user);
  return user;
}

async function land(tx: T.AnyTransaction): Promise<string> {
  const sim = await phx.simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`simulation failed: ${sim.error ?? "?"}`);
  return phx.sendAndConfirm(conn, tx);
}

async function launchBySymbol(symbol: string): Promise<T.LaunchAccount> {
  const l = (await phx.listLaunches(conn)).find((x) => x.market?.symbol === symbol);
  if (!l) throw new Error(`fixture ${symbol} missing`);
  return l;
}

/** Open vault account #0 of a fresh quantum key for `mint`, paid by `payer`. */
async function openVault(payer: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const master = phx.masterFromPhrase(phx.generateRecoveryPhrase());
  const genesis = phx.deriveVaultKey(master, "devnet", mint, 0, 0);
  genesis.skSeed.fill(0);
  await land(await phx.buildOpenVaultTx(conn, payer, mint, genesis.pk));
  return phx.vaultAddress(mint, genesis.keyId);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
  replaceStateForTests(seedState());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("commits paid into a PQ vault", () => {
  it("name an opened vault of the token, fixed by the first commit, held to the per-wallet cap together, and claimed into the vault", async () => {
    const launch = await launchBySymbol("AEGS");
    expect(phx.launchPhase(launch, BigInt(now()))).toBe("commit");
    const alice = demoUser();
    const bob = demoUser();
    const unopened = PublicKey.findProgramAddressSync([new Uint8Array([1])], phx.PROGRAM_IDS.vault)[0];
    await expect(phx.buildCommitTx(conn, alice, launch.publicKey, SOL, { tokenOwner: unopened })).rejects.toThrow(/InvalidPayoutOwner/);
    const wsolVault = await openVault(alice, phx.WSOL_MINT);
    await expect(phx.buildCommitTx(conn, alice, launch.publicKey, SOL, { tokenOwner: wsolVault })).rejects.toThrow(/InvalidPayoutOwner/);

    const vault = await openVault(alice, launch.baseMint);
    expect(await phx.fetchPayoutVault(conn, launch.publicKey, vault)).toBeNull();
    await land(await phx.buildCommitTx(conn, alice, launch.publicKey, SOL, { tokenOwner: vault }));
    expect((await phx.fetchPayoutVault(conn, launch.publicKey, vault))?.committed).toBe(SOL);
    const commit = await phx.fetchCommit(conn, launch.publicKey, alice);
    expect(commit?.tokenOwner.equals(vault)).toBe(true);
    expect(commit?.refundOwner.equals(alice)).toBe(true);
    // The first commit fixed the payout owners: a later one keeps them, and cannot change them.
    await land(await phx.buildCommitTx(conn, alice, launch.publicKey, SOL));
    await expect(phx.buildCommitTx(conn, alice, launch.publicKey, SOL, { tokenOwner: alice })).rejects.toThrow(/InvalidPayoutOwner/);
    expect((await phx.fetchPayoutVault(conn, launch.publicKey, vault))?.committed).toBe(2n * SOL);

    // Commits of any wallet naming the vault share the per-wallet cap.
    const cap = launch.batchWalletCap;
    expect(cap).toBeGreaterThan(2n * SOL);
    await expect(phx.buildCommitTx(conn, bob, launch.publicKey, cap - 2n * SOL + 1n, { tokenOwner: vault })).rejects.toThrow(/CapExceeded/);
    await land(await phx.buildCommitTx(conn, bob, launch.publicKey, cap - 2n * SOL, { tokenOwner: vault }));
    expect((await phx.fetchPayoutVault(conn, launch.publicKey, vault))?.committed).toBe(cap);

    // After the batch: the claim pays the tokens into the vault and the refund to the committer.
    vi.setSystemTime(new Date(Number(launch.commitEndTs) * 1000 + 5_000));
    if ((await phx.fetchLaunch(conn, launch.publicKey))?.executed !== true) await land(await phx.buildExecuteBatchTx(conn, bob, launch.publicKey));
    const executed = await phx.fetchLaunch(conn, launch.publicKey);
    if (executed === null) throw new Error("missing");
    const share = phx.batchShare(2n * SOL, executed.totalCommitted, executed.quoteSpent, executed.tokensOut);
    await land(await phx.buildClaimTx(conn, alice, launch.publicKey, alice));
    expect(await phx.getTokenBalance(conn, vault, launch.baseMint)).toBe(share?.tokens);
    expect(await phx.getTokenBalance(conn, alice, launch.baseMint)).toBe(0n);
  });
});

describe("a buy paid into a PQ vault", () => {
  it("lands in the vault's token account; a vault of another token is refused before anything is signed", async () => {
    const launch = await launchBySymbol("BSTN");
    expect(phx.launchPhase(launch, BigInt(now()))).toBe("guarded");
    const user = demoUser();
    const vault = await openVault(user, launch.baseMint);
    const buy = await phx.buildSwapTx(conn, user, launch.baseMint, "buy", SOL / 10n, 300, { recipient: vault });
    await land(buy.tx);
    expect(await phx.getTokenBalance(conn, vault, launch.baseMint)).toBe(buy.quote.expectedOut);
    expect(await phx.getTokenBalance(conn, user, launch.baseMint)).toBe(0n);
    const other = await openVault(user, phx.WSOL_MINT);
    await expect(phx.buildSwapTx(conn, user, launch.baseMint, "buy", SOL / 10n, 300, { recipient: other })).rejects.toThrow(/a PQ vault of another mint/);
  });
});

describe("liquidity fees after graduation", () => {
  it("are claimed one transaction per position with fees, until none is left", async () => {
    const launch = await launchBySymbol("MRDN");
    const cranker = demoUser();
    const txs = await phx.buildClaimLpFeesTx(conn, cranker, launch.publicKey);
    expect(Array.isArray(txs)).toBe(true);
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) await land(tx);
    await expect(phx.buildClaimLpFeesTx(conn, cranker, launch.publicKey)).rejects.toThrow(/no launch-authority LP position has fees/);
  });
});

describe("fee recipients (audit round 3, F3)", () => {
  /** What the cluster would hold for the mock's vault at `address` (owner, discriminator, version 4, mint): what the SDK reads. */
  function vaultAccount(address: PublicKey, mint: PublicKey): { address: PublicKey; owner: PublicKey; lamports: number; executable: boolean; data: Buffer } {
    const data = Buffer.alloc(200);
    Buffer.from(PQ_VAULT_LAYOUT.DISCRIMINATOR).copy(data, 0);
    data[PQ_VAULT_LAYOUT.VERSION_OFFSET] = PQ_VAULT_LAYOUT.VERSION;
    mint.toBuffer().copy(data, PQ_VAULT_LAYOUT.MINT_OFFSET);
    return { address, owner: phx.PROGRAM_IDS.vault, lamports: 1, executable: false, data };
  }

  it("refuse a PQ vault of another mint than wSOL before the launch is created, in the demo exactly as against a cluster", async () => {
    const launch = await launchBySymbol("AEGS");
    const user = demoUser();
    const tokenVault = await openVault(user, launch.baseMint);
    const wsolVault = await openVault(user, phx.WSOL_MINT);
    const wallet = Keypair.generate().publicKey;
    const recipients = [{ wallet }, { wallet: tokenVault }, { wallet: wsolVault }];

    const demo = await phx.checkFeeRecipients(conn, recipients);
    expect(demo.ok).toBe(false);
    expect(demo.refusals).toEqual([
      `recipients[1].wallet: a PQ vault of another mint (${launch.baseMint.toBase58()}): a vault only releases its own mint, so these tokens would be stuck forever`,
    ]);
    expect(demo.warnings).toEqual([]);
    // A wSOL vault is a fine recipient: distribute pays wSOL into its own token account.
    expect(await phx.checkFeeRecipients(conn, [{ wallet }, { wallet: wsolVault }])).toEqual({ ok: true, refusals: [], warnings: [] });
    // buildCreateLaunchTx refuses the same recipient.
    const params: T.LaunchParamsInput = { ...phx.PRESETS.turbo.params, recipients: [{ wallet: tokenVault, bps: 10_000 }], pqIdentity: new Uint8Array(32).fill(7) };
    await expect(phx.buildCreateLaunchTx(conn, user, params)).rejects.toThrow(/invalid fee recipients:\nrecipients\[0\]\.wallet: a PQ vault of another mint/);

    // The live backend reads the same accounts from the cluster and says the same.
    const { backend: live } = await import("../src/lib/backend/live");
    const accounts = new Map([
      [tokenVault.toBase58(), vaultAccount(tokenVault, launch.baseMint)],
      [wsolVault.toBase58(), vaultAccount(wsolVault, phx.WSOL_MINT)],
    ]);
    const cluster = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
      getAccountInfo: async (k: PublicKey) => accounts.get(k.toBase58()) ?? null,
    } as unknown as Connection;
    expect(await live.checkFeeRecipients(cluster, recipients)).toEqual(demo);
  });

  it("warn about an account of another program, and refuse mints and unopened vaults, like the SDK", async () => {
    const launch = await launchBySymbol("AEGS");
    const unopened = PublicKey.findProgramAddressSync([new Uint8Array([2])], phx.PROGRAM_IDS.vault)[0];
    const demo = await phx.checkFeeRecipients(conn, [{ wallet: unopened }, { wallet: launch.baseMint }, { wallet: launch.publicKey }]);
    expect(demo.ok).toBe(false);
    expect(demo.refusals).toHaveLength(2);
    expect(demo.refusals[0]).toMatch(/^recipients\[0\]\.wallet: an off-curve address with no account/);
    expect(demo.refusals[1]).toBe("recipients[1].wallet: a token account or mint is not a wallet: its own associated token account can never be moved");
    expect(demo.warnings).toEqual([`recipients[2].wallet: an off-curve account of program ${phx.PROGRAM_IDS.launchpad.toBase58()}: only that program can move what its token account receives`]);
    await expect(phx.checkFeeRecipients(conn, [{ wallet: "not a key" as unknown as PublicKey }])).rejects.toThrow(/every recipient needs a wallet PublicKey/);
  });
});

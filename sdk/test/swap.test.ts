/**
 * buildSwapTx: DBC through Meteora's SDK (quote + hook-pool swap) while the
 * curve runs, the Launch Guard rules checked first; DAMM v2 after migration
 * with a simulation-based quote.
 */
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";

import { concatBytes, toHex, u64le } from "../src/codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, KNOWN_ACCOUNTS, PROGRAM_IDS, WSOL_MINT } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { PRESETS } from "../src/launch/presets.js";
import { applyComputeBudget, buildSwapTx, canonicalizeLaunchGuardAccounts, priceImpactBps } from "../src/launch/swap.js";
import { associatedTokenAddress, dammV2PoolAddress, hookPolicyAddress, extraAccountMetaListAddress, vaultAddress, wsolAta } from "../src/pda.js";
import { ext, key, SPL, T22, tokenAccountBytes } from "./helpers.js";
import { accountBytes, metaListBytes, NOW, world, zeroed, type World } from "./world.js";

const user = key("swap/user");

/** An opened PQ vault (v4) of `mint` at its PDA. */
function openVault(w: World, mint: PublicKey, label: string): PublicKey {
  const keyId = new Uint8Array(32).fill(label.length);
  keyId.set(new TextEncoder().encode(label).slice(0, 32));
  const vault = vaultAddress(mint, keyId);
  w.conn.set(vault, {
    owner: PROGRAM_IDS.vault,
    data: accountBytes("vault", "Vault", { version: 4, bump: 255, mint, genesisKeyId: keyId, sequence: 0n, keyId, keyIdent: new Uint8Array(16), keyQ: 0, keyK: new Uint8Array(32), reserved: 0n }),
  });
  return vault;
}

function dbcCurve(w: World): void {
  const fair = PRESETS.fair.params;
  const c = w.config.config;
  c["sqrtStartPrice"] = fair.sqrtStartPrice;
  c["migrationSqrtPrice"] = fair.curve[0]!.sqrtPrice;
  const curve = c["curve"] as { sqrtPrice: bigint; liquidity: bigint }[];
  curve[0] = { sqrtPrice: fair.curve[0]!.sqrtPrice, liquidity: fair.curve[0]!.liquidity };
  curve[1] = { sqrtPrice: fair.curve[1]!.sqrtPrice, liquidity: fair.curve[1]!.liquidity };
  const ps = w.poolState["poolState"] as Record<string, unknown>;
  Object.assign(ps, { sqrtPrice: fair.sqrtStartPrice, quoteReserve: 0n, activationPoint: w.launchState["launchTs"], poolType: 1 });
  w.build();
}

describe("DBC (bonding curve running)", () => {
  it("quotes with Meteora's SDK and builds a hook-pool swap with the Launch Guard accounts", async () => {
    const w = world();
    dbcCurve(w);
    w.conn.blockTime = NOW;
    const { tx, quote } = await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100);
    expect(quote).toMatchObject({ side: "buy", venue: "dbc", amountIn: 10_000_000n, method: "dbc-sdk" });
    expect(quote.expectedOut > 0n).toBe(true);
    expect(quote.minimumOut).toBe((quote.expectedOut * 9_900n) / 10_000n);
    expect(quote.feeBps).toBe(100);
    expect(tx.feePayer?.equals(user)).toBe(true);
    const swap = tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.dbc))!;
    const disc = idlCodecs().dbc.instruction("swap2_with_transfer_hook").discriminator;
    expect(toHex(swap.data.subarray(0, 8))).toBe(toHex(Uint8Array.from(disc)));
    const keys = swap.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(w.pool.toBase58());
    // Meteora's SDK resolved the Launch Guard's four accounts; they are in the launchpad's canonical order.
    expect(swap.keys.slice(-4).map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      [extraAccountMetaListAddress(w.mint), hookPolicyAddress(w.mint), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook].map((k) => [k.toBase58(), false, false]),
    );
    expect(swap.keys.length).toBe(idlCodecs().dbc.instruction("swap2_with_transfer_hook").accounts.length + 4);
    expect(swap.keys.some((k) => k.pubkey.equals(user) && k.isSigner)).toBe(true);
  });

  it("refuses when the hook accounts Meteora's SDK resolves are not the Launch Guard's four", async () => {
    const w = world();
    dbcCurve(w);
    w.conn.blockTime = NOW;
    // A meta list without the instructions sysvar (the pre-audit layout) resolves to three accounts.
    const old = metaListBytes().slice(0, 51);
    new DataView(old.buffer).setUint32(8, 39, true);
    new DataView(old.buffer).setUint32(12, 1, true);
    w.conn.set(extraAccountMetaListAddress(w.mint), { owner: PROGRAM_IDS.hook, data: old });
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).rejects.toThrow(/Launch Guard's 4 hook accounts/);
  });

  it("canonicalizeLaunchGuardAccounts checks the set before reordering", () => {
    const mint = key("swap/canon-mint");
    const def = idlCodecs().dbc.instruction("swap2_with_transfer_hook");
    const data = idlCodecs().dbc.encodeInstruction("swap2_with_transfer_hook", {
      params: { amount0: 1n, amount1: 0n, swapMode: 1 },
      transferHookAccountsInfo: { slices: [{ accountsType: { kind: "TransferHookBase" }, length: 4 }] },
    });
    const fixed = def.accounts.map((_, i) => ({ pubkey: key(`swap/fixed-${i}`), isSigner: false, isWritable: false }));
    const resolver = [hookPolicyAddress(mint), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook, extraAccountMetaListAddress(mint)].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
    const tx = new Transaction().add(new TransactionInstruction({ programId: PROGRAM_IDS.dbc, keys: [...fixed, ...resolver], data: Buffer.from(data) }));
    canonicalizeLaunchGuardAccounts(tx, mint);
    expect(tx.instructions[0]!.keys.slice(-4).map((k) => k.pubkey.toBase58())).toEqual(
      [extraAccountMetaListAddress(mint), hookPolicyAddress(mint), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook].map((k) => k.toBase58()),
    );
    const wrong = new Transaction().add(new TransactionInstruction({ programId: PROGRAM_IDS.dbc, keys: [...fixed, ...resolver.slice(0, 3), { pubkey: key("evil"), isSigner: false, isWritable: false }], data: Buffer.from(data) }));
    expect(() => canonicalizeLaunchGuardAccounts(wrong, mint)).toThrow(/not the Launch Guard's/);
    const writable = new Transaction().add(new TransactionInstruction({ programId: PROGRAM_IDS.dbc, keys: [...fixed, ...resolver.map((r, i) => ({ ...r, isWritable: i === 0 }))], data: Buffer.from(data) }));
    expect(() => canonicalizeLaunchGuardAccounts(writable, mint)).toThrow(/not the Launch Guard's/);
  });

  it("refuses buys the Launch Guard would refuse", async () => {
    const w = world();
    dbcCurve(w);
    w.conn.blockTime = Number(w.cert["snipeShieldEndTs"]) - 1;
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).rejects.toThrow(/buying opens/);
    w.conn.blockTime = NOW;
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000_000n, 100)).rejects.toThrow(/caps one buy/);
    const ata = associatedTokenAddress(user, w.mint, T22);
    w.conn.set(ata, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: user, amount: w.cert["maxWallet"] as bigint, token2022: true, extensions: [ext.immutableOwner()] }) });
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).rejects.toThrow(/caps the receiving account/);
    // Audit round 3 F2 (MutableOwner 6010): a receiving account whose owner can be reassigned is refused while the guard is on.
    w.conn.set(ata, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: user, amount: 0n, token2022: true }) });
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).rejects.toThrow(/owner can be reassigned .*MutableOwner 6010/);
    w.conn.set(ata, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: user, amount: 0n, token2022: true, extensions: [ext.immutableOwner()] }) });
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).resolves.toBeDefined();
    // Once the guard ended, nothing changes: the hook allows every transfer.
    w.conn.set(ata, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: user, amount: 0n, token2022: true }) });
    w.conn.blockTime = Number(w.policy["guardEndTs"] as bigint);
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).resolves.toBeDefined();
  });

  it("buys open as soon as the batch ended the shield (the live policy, not the certificate's schedule)", async () => {
    const w = world();
    dbcCurve(w);
    const scheduled = w.cert["snipeShieldEndTs"] as bigint;
    w.policy["snipeShieldEndTs"] = scheduled - 300n; // execute_batch ran 300 s before the scheduled end
    w.build();
    w.conn.blockTime = Number(scheduled) - 1;
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).resolves.toBeDefined();
    w.conn.blockTime = Number(scheduled) - 301;
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100)).rejects.toThrow(/buying opens/);
  });

  it("buys straight into a PQ vault: DBC's output_token_account is the vault's ATA, created by the user; max-wallet applies to it", async () => {
    const w = world();
    dbcCurve(w);
    w.conn.blockTime = NOW;
    const vault = openVault(w, w.mint, "swap/vault");
    const vaultAta = associatedTokenAddress(vault, w.mint, T22);
    const { tx, quote, warnings } = await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100, { recipient: vault });
    expect(quote.expectedOut > 0n).toBe(true);
    const swap = tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.dbc))!;
    const def = idlCodecs().dbc.instruction("swap2_with_transfer_hook");
    const at = (name: string): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } => swap.keys[def.accounts.findIndex((a) => a.name === name)]!;
    expect(at("output_token_account")).toEqual({ pubkey: vaultAta, isSigner: false, isWritable: true });
    expect(at("input_token_account").pubkey.equals(wsolAta(user))).toBe(true);
    expect(at("payer")).toMatchObject({ pubkey: user, isSigner: true });
    expect(swap.keys.some((k) => k.pubkey.equals(associatedTokenAddress(user, w.mint, T22)))).toBe(false);
    // The vault's ATA is created (idempotently, paid by the user); the user's own base ATA is not.
    const creates = tx.instructions.filter((i) => i.programId.equals(KNOWN_ACCOUNTS.associatedToken));
    expect(creates.map((c) => [c.keys[0]!.pubkey.toBase58(), c.keys[1]!.pubkey.toBase58(), c.keys[2]!.pubkey.toBase58(), Array.from(c.data)])).toContainEqual([user.toBase58(), vaultAta.toBase58(), vault.toBase58(), [1]]);
    expect(creates.some((c) => c.keys[1]!.pubkey.equals(associatedTokenAddress(user, w.mint, T22)))).toBe(false);
    expect(warnings.join()).toMatch(/Launch Guard caps every transfer out of this account/);
    // Max-wallet is the receiving account's: a full user wallet does not matter, a full vault refuses.
    w.conn.set(associatedTokenAddress(user, w.mint, T22), { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: user, amount: w.cert["maxWallet"] as bigint, token2022: true, extensions: [ext.immutableOwner()] }) });
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100, { recipient: vault })).resolves.toBeDefined();
    w.conn.set(vaultAta, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: vault, amount: w.cert["maxWallet"] as bigint, token2022: true, extensions: [ext.immutableOwner()] }) });
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100, { recipient: vault })).rejects.toThrow(/caps the receiving account/);
  });

  it("refuses recipients whose token account nobody could move", async () => {
    const w = world();
    dbcCurve(w);
    w.conn.blockTime = NOW;
    const c = w.conn.asConnection();
    // A vault of another mint, a token account, an off-curve address with no account.
    await expect(buildSwapTx(c, user, w.mint, "buy", 10_000_000n, 100, { recipient: openVault(w, WSOL_MINT, "swap/wsol-vault") })).rejects.toThrow(/another mint/);
    const tokenAccount = associatedTokenAddress(user, w.mint, T22);
    w.conn.set(tokenAccount, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: user, amount: 0n, token2022: true }) });
    await expect(buildSwapTx(c, user, w.mint, "buy", 10_000_000n, 100, { recipient: tokenAccount })).rejects.toThrow(/token account or mint/);
    await expect(buildSwapTx(c, user, w.mint, "buy", 10_000_000n, 100, { recipient: vaultAddress(w.mint, new Uint8Array(32).fill(9)) })).rejects.toThrow(/off-curve address with no account/);
  });

  it("input validation and lifecycle", async () => {
    const w = world();
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 0n, 100)).rejects.toThrow(/positive/);
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1n, 5_001)).rejects.toThrow(/slippage/);
    await expect(buildSwapTx(w.conn.asConnection(), user, key("not-noised"), "sell", 1n, 100)).rejects.toThrow(/not a Noised launch/);
    (w.poolState["poolState"] as Record<string, unknown>)["quoteReserve"] = w.launchState["migrationQuoteThreshold"];
    w.build();
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "sell", 1n, 100)).rejects.toThrow(/curve completed/);
  });
});

function migrate(w: World): { pool: PublicKey } {
  const ps = w.poolState["poolState"] as Record<string, unknown>;
  Object.assign(ps, { quoteReserve: w.launchState["migrationQuoteThreshold"], migrationProgress: 3, isMigrated: 1 });
  w.mintOpts.extensions[1] = ext.transferHook(null, null);
  const pool = dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, w.mint, WSOL_MINT);
  const poolState = zeroed("dammV2", "Pool");
  Object.assign(poolState, { tokenAMint: w.mint, tokenBMint: WSOL_MINT, tokenAVault: key("damm/va"), tokenBVault: key("damm/vb"), creator: KNOWN_ACCOUNTS.dbcPoolAuthority, sqrtPrice: 1n << 64n });
  (poolState["poolFees"] as { baseFee: { baseFeeInfo: { data: Uint8Array } } }).baseFee.baseFeeInfo.data = concatBytes([u64le(10_000_000n), new Uint8Array(24)]);
  const b = w.build;
  w.build = () => {
    b();
    w.conn.set(pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", poolState) });
  };
  w.build();
  return { pool };
}

describe("DAMM v2 (after migration)", () => {
  it("quotes by simulating the exact swap, then applies the slippage bound", async () => {
    const w = world();
    const { pool } = migrate(w);
    const out = associatedTokenAddress(user, w.mint, T22);
    let simulated: Transaction | null = null;
    w.conn.simulate = (vtx, config) => {
      simulated = vtx as Transaction;
      expect((config as { accounts: { addresses: string[] } }).accounts.addresses).toEqual([out.toBase58()]);
      const data = Buffer.from(tokenAccountBytes({ mint: w.mint, owner: user, amount: 990_000n, token2022: true })).toString("base64");
      return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ owner: T22.toBase58(), data: [data, "base64"], lamports: 1, executable: false, rentEpoch: 0 }] } };
    };
    const { tx, quote } = await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000n, 100);
    expect(simulated).not.toBeNull();
    expect(quote).toMatchObject({ venue: "damm-v2", expectedOut: 990_000n, minimumOut: 980_100n, feeBps: 100, method: "simulation" });
    expect(quote.priceImpactBps).toBe(100);
    const swap = tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.dammV2))!;
    const codec = idlCodecs().dammV2;
    expect(toHex(swap.data)).toBe(toHex(codec.encodeInstruction("swap2", { _params: { amount0: 1_000_000n, amount1: 980_100n, swapMode: 0 } })));
    expect(swap.keys.slice(0, 14).map((k) => k.pubkey.toBase58())).toEqual(
      [
        KNOWN_ACCOUNTS.dammV2PoolAuthority,
        pool,
        wsolAta(user),
        out,
        key("damm/va"),
        key("damm/vb"),
        w.mint,
        WSOL_MINT,
        user,
        T22,
        SPL,
        PROGRAM_IDS.dammV2, // referral: None
        KNOWN_ACCOUNTS.dammV2EventAuthority,
        PROGRAM_IDS.dammV2,
      ].map((k) => k.toBase58()),
    );
    // wSOL is wrapped before and the temporary wSOL account closed after.
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual(
      [KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.system, SPL, PROGRAM_IDS.dammV2, SPL].map((k) => k.toBase58()),
    );
  });

  it("compute budget is opt-in: none by default; a priority fee and a limit go first, replacing nothing of the swap; checked before any read", async () => {
    const simulateOk = (w: World): void => {
      const out = associatedTokenAddress(user, w.mint, T22);
      w.conn.simulate = () => {
        const data = Buffer.from(tokenAccountBytes({ mint: w.mint, owner: user, amount: 990_000n, token2022: true })).toString("base64");
        return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ owner: T22.toBase58(), data: [data, "base64"], lamports: 1, executable: false, rentEpoch: 0 }] } };
      };
      void out;
    };
    const w = world();
    migrate(w);
    simulateOk(w);
    const plain = (await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000n, 100)).tx;
    expect(plain.instructions.some((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget))).toBe(false);
    const priced = (await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000n, 100, { computeUnitPrice: 5_000n })).tx;
    expect(priced.instructions.map((i) => i.programId.toBase58())).toEqual([KNOWN_ACCOUNTS.computeBudget, ...plain.instructions.map((i) => i.programId)].map((k) => k.toBase58()));
    expect(toHex(priced.instructions[0]!.data)).toBe(toHex(concatBytes([Uint8Array.of(3), u64le(5_000n)]))); // SetComputeUnitPrice
    const both = (await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000n, 100, { computeUnitPrice: 5_000n, computeUnitLimit: 150_000 })).tx;
    expect(toHex(both.instructions[0]!.data)).toBe("02f0490200"); // SetComputeUnitLimit 150,000
    expect(toHex(both.instructions[1]!.data)).toBe(toHex(concatBytes([Uint8Array.of(3), u64le(5_000n)])));
    expect(both.instructions.slice(2).map((i) => toHex(i.data))).toEqual(plain.instructions.map((i) => toHex(i.data)));
    expect(both.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThanOrEqual(1_232);
    // Bad options are refused before anything is read.
    const reads = w.conn.calls.length;
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000n, 100, { computeUnitLimit: 0 })).rejects.toThrow(/computeUnitLimit/);
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000n, 100, { computeUnitPrice: -1n })).rejects.toThrow(/computeUnitPrice/);
    expect(w.conn.calls.length).toBe(reads);
  });

  it("a DBC swap through Meteora's SDK takes the caller's budget instead of the SDK's; one over the legacy size is refused", async () => {
    const w = world();
    dbcCurve(w);
    w.conn.blockTime = NOW;
    const { tx } = await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100, { computeUnitPrice: 1n });
    const budget = tx.instructions.filter((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget));
    expect(budget.map((i) => toHex(i.data))).toEqual([toHex(concatBytes([Uint8Array.of(3), u64le(1n)]))]);
    expect(tx.instructions[0]!.programId.equals(KNOWN_ACCOUNTS.computeBudget)).toBe(true);
    // A recipient's ATA creation plus both budget instructions can push a hooked swap over 1,232 bytes: refused with the reason.
    const vault = openVault(w, w.mint, "swap/budget-vault");
    const r = buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 10_000_000n, 100, { recipient: vault, computeUnitPrice: 1n, computeUnitLimit: 400_000 });
    await r.then(
      (ok) => expect(ok.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThanOrEqual(1_232),
      (e: unknown) => expect(String(e)).toMatch(/over the 1232-byte legacy limit: drop computeUnitLimit/),
    );
  });

  it("refuses disabled pools and failed simulations", async () => {
    const w = world();
    migrate(w);
    w.conn.simulate = () => ({ context: { slot: 1 }, value: { err: { InstructionError: [4, { Custom: 6000 }] }, logs: [`Program ${PROGRAM_IDS.dammV2.toBase58()} failed: custom program error: 0x1770`], accounts: [null] } });
    await expect(buildSwapTx(w.conn.asConnection(), user, w.mint, "sell", 5n, 100)).rejects.toThrow(/simulation failed/);
    const d = world();
    const { pool } = migrate(d);
    const st = idlCodecs().dammV2.decodeAccount<Record<string, unknown>>("Pool", d.conn.get(pool)!.data);
    st["poolStatus"] = 1;
    d.conn.set(pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", st) });
    d.build = () => {};
    await expect(buildSwapTx(d.conn.asConnection(), user, d.mint, "sell", 5n, 100)).rejects.toThrow(/disabled/);
  });
});

describe("DAMM v2 into a recipient (after migration)", () => {
  it("buy: output = the vault's ATA (created by the user), the simulation reads it; the user's wSOL wrapper is closed", async () => {
    const w = world();
    migrate(w);
    const vault = openVault(w, w.mint, "damm/vault");
    const vaultAta = associatedTokenAddress(vault, w.mint, T22);
    w.conn.simulate = (_vtx, config) => {
      expect((config as { accounts: { addresses: string[] } }).accounts.addresses).toEqual([vaultAta.toBase58()]);
      const data = Buffer.from(tokenAccountBytes({ mint: w.mint, owner: vault, amount: 500_000n, token2022: true })).toString("base64");
      return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ owner: T22.toBase58(), data: [data, "base64"], lamports: 1, executable: false, rentEpoch: 0 }] } };
    };
    const { tx, quote, warnings } = await buildSwapTx(w.conn.asConnection(), user, w.mint, "buy", 1_000_000n, 100, { recipient: vault });
    expect(quote.expectedOut).toBe(500_000n);
    expect(warnings).toEqual([]);
    const swap = tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.dammV2))!;
    expect(swap.keys[2]!.pubkey.equals(wsolAta(user))).toBe(true); // input: the user's
    expect(swap.keys[3]).toEqual({ pubkey: vaultAta, isSigner: false, isWritable: true }); // output: the vault's
    expect(swap.keys[8]).toMatchObject({ pubkey: user, isSigner: true });
    const create = tx.instructions[0]!;
    expect(create.programId.equals(KNOWN_ACCOUNTS.associatedToken)).toBe(true);
    expect([create.keys[0]!.pubkey, create.keys[1]!.pubkey, create.keys[2]!.pubkey, create.keys[3]!.pubkey].map((k) => k.toBase58())).toEqual([user, vaultAta, vault, w.mint].map((k) => k.toBase58()));
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual(
      [KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.system, SPL, PROGRAM_IDS.dammV2, SPL].map((k) => k.toBase58()),
    );
  });

  it("sell: proceeds to a wSOL vault's ATA; the user's wSOL account is neither created nor closed", async () => {
    const w = world();
    migrate(w);
    const vault = openVault(w, WSOL_MINT, "damm/wsol-vault");
    const vaultWsol = wsolAta(vault);
    w.conn.simulate = () => {
      const data = Buffer.from(tokenAccountBytes({ mint: WSOL_MINT, owner: vault, amount: 42n })).toString("base64");
      return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ owner: SPL.toBase58(), data: [data, "base64"], lamports: 1, executable: false, rentEpoch: 0 }] } };
    };
    const { tx } = await buildSwapTx(w.conn.asConnection(), user, w.mint, "sell", 5n, 100, { recipient: vault });
    const swap = tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.dammV2))!;
    expect(swap.keys[2]!.pubkey.equals(associatedTokenAddress(user, w.mint, T22))).toBe(true);
    expect(swap.keys[3]!.pubkey.equals(vaultWsol)).toBe(true);
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual([KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.associatedToken, PROGRAM_IDS.dammV2].map((k) => k.toBase58()));
    expect(tx.instructions.some((i) => i.keys.some((k) => k.pubkey.equals(wsolAta(user))))).toBe(false);
  });
});

describe("the swap's compute budget (applyComputeBudget)", () => {
  const swapLike = (dataLen: number, withBudget: boolean): Transaction => {
    const tx = new Transaction();
    tx.feePayer = user;
    tx.recentBlockhash = "11111111111111111111111111111111";
    if (withBudget) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })); // as a Meteora builder might add
    tx.add(new TransactionInstruction({ programId: PROGRAM_IDS.dbc, keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: Buffer.alloc(dataLen, 7) }));
    return tx;
  };
  const budgetData = (tx: Transaction): string[] => tx.instructions.filter((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget)).map((i) => toHex(i.data));

  it("without options the transaction is left exactly as built, a compute-budget instruction of the builder included", () => {
    const tx = swapLike(100, true);
    const before = tx.instructions.map((i) => toHex(i.data));
    applyComputeBudget(tx, {});
    expect(tx.instructions.map((i) => toHex(i.data))).toEqual(before);
  });

  it("with options, the caller's instructions replace the builder's (never two of one kind) and come first", () => {
    const tx = swapLike(100, true);
    applyComputeBudget(tx, { computeUnitLimit: 150_000, computeUnitPrice: 5_000n });
    expect(budgetData(tx)).toEqual(["02f0490200", toHex(concatBytes([Uint8Array.of(3), u64le(5_000n)]))]);
    expect(tx.instructions.map((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget))).toEqual([true, true, false]);
  });

  it("a swap that would no longer fit 1,232 bytes is refused with the reason (not web3.js's bare size assertion)", () => {
    // 1,232 - 1 - 64 - message overhead: the instruction data that fills the packet exactly without a budget.
    const fits = swapLike(1_000, false);
    const m = fits.compileMessage();
    const room = 1_232 - (1 + 64 + m.serialize().length);
    const full = swapLike(1_000 + room, false);
    applyComputeBudget(full, {}); // untouched: exactly 1,232 bytes
    expect(full.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBe(1_232);
    const priced = swapLike(1_000 + room, false);
    expect(() => applyComputeBudget(priced, { computeUnitPrice: 1n })).toThrow(/is 1276 bytes, over the 1232-byte legacy limit: drop computeUnitLimit/);
  });
});

describe("price impact", () => {
  it("is the shortfall against the spot price, fees included", () => {
    const one = 1n << 64n; // price 1 quote per base
    expect(priceImpactBps("buy", 1_000n, 1_000n, one)).toBe(0);
    expect(priceImpactBps("buy", 1_000n, 900n, one)).toBe(1_000);
    expect(priceImpactBps("sell", 1_000n, 990n, one)).toBe(100);
    expect(priceImpactBps("sell", 1_000n, 990n, 0n)).toBeNull();
  });
});

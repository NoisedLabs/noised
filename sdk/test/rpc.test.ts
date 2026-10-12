/** simulateAndExplain (error mapping from the IDLs) and sendAndConfirm (legacy and raw v1). */
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";

import { encodeBase58 } from "../src/codec/base58.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS } from "../src/constants.js";
import { customErrorCode, explainProgramError, explainTransactionError, failedProgramFromLogs } from "../src/rpc/errors.js";
import { getSolBalance, getTokenBalance, getTokenSupply, rentExemptLamports, sendAndConfirm, simulateAndExplain } from "../src/rpc/index.js";
import { compileV1Message, signV1Message } from "../src/tx/v1.js";
import { key, MockConnection, mintBytes, SPL, tokenAccountBytes } from "./helpers.js";

const LP = PROGRAM_IDS.launchpad.toBase58();
const HOOK = PROGRAM_IDS.hook.toBase58();
const T22 = KNOWN_ACCOUNTS.token2022.toBase58();
const DBC = PROGRAM_IDS.dbc.toBase58();

describe("error mapping", () => {
  it("names errors from the IDLs, Anchor and SPL Token", () => {
    expect(explainProgramError(LP, 6023)).toMatchObject({ program: "noised_launchpad", name: "NotCommitWindow" });
    expect(explainProgramError(LP, 6038)?.name).toBe("PoolAlreadyTraded");
    expect(explainProgramError(HOOK, 6000)?.message).toMatch(/snipe-shield/);
    expect(explainProgramError(PROGRAM_IDS.vault.toBase58(), 6001)?.name).toBe("InvalidSignature");
    expect(explainProgramError(PROGRAM_IDS.vault.toBase58(), 6004)?.name).toBe("InvalidDestination");
    expect(explainProgramError(PROGRAM_IDS.shield.toBase58(), 6000)?.name).toBe("UnsupportedExtension");
    expect(explainProgramError(LP, 3012)?.name).toBe("AccountNotInitialized");
    expect(explainProgramError(LP, 2006)?.name).toBe("ConstraintSeeds");
    expect(explainProgramError(T22, 1)?.name).toBe("InsufficientFunds");
    expect(explainProgramError(DBC, 6000)).not.toBeNull();
    expect(explainProgramError(key("unknown").toBase58(), 1)).toBeNull();
  });

  it("attributes a CPI failure to the innermost failing program", () => {
    // A buy during the snipe shield: the hook fails inside Token-2022 inside DBC.
    const logs = [
      `Program ${DBC} invoke [1]`,
      `Program ${T22} invoke [2]`,
      `Program ${HOOK} invoke [3]`,
      "Program log: AnchorError occurred. Error Code: SnipeShield. Error Number: 6000. Error Message: Launch guard: buying opens when the snipe-shield countdown ends.",
      `Program ${HOOK} failed: custom program error: 0x1770`,
      `Program ${T22} failed: custom program error: 0x1770`,
      `Program ${DBC} failed: custom program error: 0x1770`,
    ];
    expect(failedProgramFromLogs(logs)).toMatchObject({ programId: HOOK, code: 6000 });
    const e = explainTransactionError({ InstructionError: [0, { Custom: 6000 }] }, logs);
    expect(e.errorCode).toEqual({ program: "noised_hook", code: 6000, name: "SnipeShield" });
    expect(e.error).toMatch(/snipe-shield/);
    expect(explainTransactionError("InsufficientFundsForFee", []).error).toBe("InsufficientFundsForFee");
  });
});

describe("customErrorCode (what a failed send carries) and the metadata errors", () => {
  it("from preflight logs, a confirmation's InstructionError, the runtime's hex code, or a cause; null otherwise", () => {
    const preflight = Object.assign(new Error("Simulation failed"), { logs: [`Program ${LP} invoke [1]`, `Program ${LP} failed: custom program error: 0x7d6`] });
    expect(customErrorCode(preflight)).toBe(2006);
    expect(customErrorCode(new Error('transaction 5x failed: {"InstructionError":[0,{"Custom":6041}]}'))).toBe(6041);
    expect(customErrorCode(new Error("Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1799"))).toBe(6041);
    expect(customErrorCode(new Error("did not land", { cause: new Error('{"Custom":3012}') }))).toBe(3012);
    expect(customErrorCode("custom program error: 0x177d")).toBe(6013);
    expect(customErrorCode(new Error("Blockhash not found"))).toBeNull();
    expect(customErrorCode(null)).toBeNull();
    expect(customErrorCode({ logs: ["Program x success"] })).toBeNull();
  });

  it("names the on-chain metadata errors and 6016's new message", () => {
    expect(explainProgramError(LP, 6045)).toMatchObject({ name: "InvalidMetadataFlags", message: expect.stringMatching(/uri without the external-uri flag/) });
    expect(explainProgramError(LP, 6046)?.name).toBe("MetadataTooLong");
    expect(explainProgramError(LP, 6047)?.name).toBe("MetadataMismatch");
    expect(explainProgramError(LP, 6016)?.message).toMatch(/external uri is not https:\/\/ in printable ASCII/);
  });

  it("rentExemptLamports reads the cluster's rent", async () => {
    const conn = new MockConnection() as MockConnection & { getMinimumBalanceForRentExemption: (n: number) => Promise<number> };
    conn.getMinimumBalanceForRentExemption = async (n) => (128 + n) * 6_960;
    expect(await rentExemptLamports(conn.asConnection(), 1_244)).toBe(9_549_120n);
    await expect(rentExemptLamports(conn.asConnection(), -1)).rejects.toThrow(/size/);
    conn.getMinimumBalanceForRentExemption = async () => -5;
    await expect(rentExemptLamports(conn.asConnection(), 0)).rejects.toThrow(/invalid rent-exempt minimum/);
  });
});

describe("simulateAndExplain", () => {
  const payer = Keypair.generate();
  const conn = new MockConnection();

  it("legacy: unsigned simulation, explained failure, signers, writable accounts, unknown programs", async () => {
    const tx = new Transaction().add(
      new TransactionInstruction({ programId: PROGRAM_IDS.launchpad, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }),
      new TransactionInstruction({ programId: key("mystery"), keys: [], data: Buffer.alloc(0) }),
    );
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = conn.blockhash;
    let seen: unknown = null;
    conn.simulate = (_tx, config) => {
      seen = config;
      return {
        context: { slot: 1 },
        value: { err: { InstructionError: [0, { Custom: 6023 }] }, logs: [`Program ${LP} invoke [1]`, `Program ${LP} failed: custom program error: 0x1787`], unitsConsumed: 1234 },
      };
    };
    const r = await simulateAndExplain(conn.asConnection(), tx);
    expect(seen).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toEqual({ program: "noised_launchpad", code: 6023, name: "NotCommitWindow" });
    expect(r.failedInstruction).toBe(0);
    expect(r.format).toBe("legacy");
    expect(r.sizeLimit).toBe(1232);
    expect(r.unknownPrograms.map((p) => p.toBase58())).toEqual([key("mystery").toBase58()]);
    expect(r.signers.map((s) => s.toBase58())).toEqual([payer.publicKey.toBase58()]);
    expect(r.writableAccounts.some((w) => w.equals(payer.publicKey))).toBe(true);
    expect(r.feeLamports).toBe(5_000n);
    expect(r.unitsConsumed).toBe(1234);
  });

  it("v1: raw bytes simulated through JSON-RPC", async () => {
    const program = PROGRAM_IDS.vault;
    const m = compileV1Message(payer.publicKey, [new TransactionInstruction({ programId: program, keys: [], data: Buffer.from([1, 2]) })], conn.blockhash, {
      computeUnitLimit: 400_000,
      loadedAccountsDataSizeLimit: 4 << 20,
    });
    const wire = signV1Message(m, [payer]);
    const calls: unknown[] = [];
    (conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> })._rpcRequest = async (method, args) => {
      calls.push([method, args]);
      return { result: { context: { slot: 1 }, value: { err: null, logs: ["ok"], unitsConsumed: 99 } } };
    };
    const r = await simulateAndExplain(conn.asConnection(), wire);
    expect(r).toMatchObject({ ok: true, format: "v1", sizeLimit: 4096, sizeBytes: wire.length, unitsConsumed: 99, feeLamports: 5_000n, failedInstruction: null });
    expect(r.programs.map((p) => p.name)).toEqual(["noised_vault"]);
    expect((calls[0] as [string, unknown[]])[0]).toBe("simulateTransaction");
    expect(((calls[0] as [string, unknown[]])[1][1] as { encoding: string }).encoding).toBe("base64");
  });
});

describe("sendAndConfirm", () => {
  it("sends raw v1 bytes and confirms by the fee payer's signature", async () => {
    const payer = Keypair.generate();
    const m = compileV1Message(payer.publicKey, [new TransactionInstruction({ programId: PROGRAM_IDS.vault, keys: [], data: Buffer.from([1]) })], encodeBase58(new Uint8Array(32).fill(3)), {
      computeUnitLimit: 400_000,
      loadedAccountsDataSizeLimit: 4 << 20,
    });
    const wire = signV1Message(m, [payer]);
    const sig = encodeBase58(wire.subarray(wire.length - 64));
    const sent: Uint8Array[] = [];
    const confirmed: unknown[] = [];
    const conn = {
      sendRawTransaction: async (raw: Uint8Array) => {
        sent.push(raw);
        return sig;
      },
      confirmTransaction: async (strategy: unknown) => {
        confirmed.push(strategy);
        return { context: { slot: 1 }, value: { err: null } };
      },
      getBlockHeight: async () => 100,
    };
    expect(await sendAndConfirm(conn as never, wire)).toBe(sig);
    expect(sent[0]).toEqual(wire);
    expect(confirmed[0]).toMatchObject({ signature: sig, blockhash: encodeBase58(new Uint8Array(32).fill(3)), lastValidBlockHeight: 250 });

    const failing = { ...conn, confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [0, "X"] } } }) };
    await expect(sendAndConfirm(failing as never, wire)).rejects.toThrow(/failed/);
  });

  it("waiting for finalized still preflights at confirmed, where the builders' blockhash is known (no BlockhashNotFound)", async () => {
    // Every builder fetches its blockhash at `confirmed`; a finalized bank does not know it for ~13 s.
    const payer = Keypair.generate();
    const blockhash = encodeBase58(new Uint8Array(32).fill(4));
    const wire = signV1Message(
      compileV1Message(payer.publicKey, [new TransactionInstruction({ programId: PROGRAM_IDS.vault, keys: [], data: Buffer.from([1]) })], blockhash, {
        computeUnitLimit: 400_000,
        loadedAccountsDataSizeLimit: 4 << 20,
      }),
      [payer],
    );
    const sig = encodeBase58(wire.subarray(wire.length - 64));
    const seen: { preflight: unknown[]; heights: unknown[]; waited: unknown[] } = { preflight: [], heights: [], waited: [] };
    const conn = {
      sendRawTransaction: async (_raw: Uint8Array, o: { preflightCommitment?: string; skipPreflight?: boolean }) => {
        seen.preflight.push(o.preflightCommitment);
        if (o.skipPreflight !== true && o.preflightCommitment === "finalized") throw new Error("failed to send transaction: Transaction simulation failed: Blockhash not found");
        return sig;
      },
      confirmTransaction: async (_s: unknown, commitment: string) => {
        seen.waited.push(commitment);
        return { context: { slot: 1 }, value: { err: null } };
      },
      // The finalized height lags: an expiry computed from it would be ~32 blocks too early.
      getBlockHeight: async (commitment: string) => {
        seen.heights.push(commitment);
        return commitment === "finalized" ? 68 : 100;
      },
    };
    expect(await sendAndConfirm(conn as never, wire, { commitment: "finalized" })).toBe(sig);
    expect(seen).toEqual({ preflight: ["confirmed"], heights: ["confirmed"], waited: ["finalized"] });
    // The default waits at confirmed, with the same preflight.
    expect(await sendAndConfirm(conn as never, wire)).toBe(sig);
    expect(seen.preflight).toEqual(["confirmed", "confirmed"]);
    expect(seen.waited).toEqual(["finalized", "confirmed"]);
  });

  it("preflightCommitment: a transaction built with a processed blockhash preflights at processed (review finding)", async () => {
    // Regression: 0.3.0 hard-coded the preflight at confirmed, so a blockhash fetched at processed could be refused
    // with BlockhashNotFound by a confirmed bank that does not know it yet.
    const payer = Keypair.generate();
    const wire = signV1Message(
      compileV1Message(payer.publicKey, [new TransactionInstruction({ programId: PROGRAM_IDS.vault, keys: [], data: Buffer.from([2]) })], encodeBase58(new Uint8Array(32).fill(6)), {
        computeUnitLimit: 400_000,
        loadedAccountsDataSizeLimit: 4 << 20,
      }),
      [payer],
    );
    const sig = encodeBase58(wire.subarray(wire.length - 64));
    const seen: { preflight: unknown[]; heights: unknown[]; waited: unknown[] } = { preflight: [], heights: [], waited: [] };
    const conn = {
      sendRawTransaction: async (_raw: Uint8Array, o: { preflightCommitment?: string }) => {
        seen.preflight.push(o.preflightCommitment);
        if (o.preflightCommitment !== "processed") throw new Error("failed to send transaction: Transaction simulation failed: Blockhash not found");
        return sig;
      },
      confirmTransaction: async (_s: unknown, commitment: string) => {
        seen.waited.push(commitment);
        return { context: { slot: 1 }, value: { err: null } };
      },
      getBlockHeight: async (commitment: string) => {
        seen.heights.push(commitment);
        return 100;
      },
    };
    await expect(sendAndConfirm(conn as never, wire)).rejects.toThrow(/Blockhash not found/);
    expect(await sendAndConfirm(conn as never, wire, { preflightCommitment: "processed" })).toBe(sig);
    expect(seen).toEqual({ preflight: ["confirmed", "processed"], heights: ["confirmed", "processed"], waited: ["confirmed"] });
  });

  it("refuses an unsigned legacy transaction", async () => {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: key("a"), toPubkey: key("b"), lamports: 1 }));
    tx.feePayer = key("a");
    tx.recentBlockhash = encodeBase58(new Uint8Array(32).fill(5));
    await expect(sendAndConfirm({ getBlockHeight: async () => 1 } as never, tx)).rejects.toThrow();
  });
});

describe("balances", () => {
  it("reads SOL, token and supply amounts as bigints", async () => {
    const c = new MockConnection();
    const mint = key("bal/mint");
    const owner = key("bal/owner");
    c.set(owner, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 42 });
    c.set(mint, { owner: SPL, data: mintBytes({ supply: 777n }) });
    expect(await getSolBalance(c.asConnection(), owner)).toBe(42n);
    expect(await getTokenSupply(c.asConnection(), mint)).toBe(777n);
    expect(await getTokenBalance(c.asConnection(), owner, mint)).toBe(0n);
    const ata = PublicKey.findProgramAddressSync([owner.toBytes(), SPL.toBytes(), mint.toBytes()], KNOWN_ACCOUNTS.associatedToken)[0];
    c.set(ata, { owner: SPL, data: tokenAccountBytes({ mint, owner, amount: 9n }) });
    expect(await getTokenBalance(c.asConnection(), owner, mint)).toBe(9n);
  });
});

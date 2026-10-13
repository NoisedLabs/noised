/**
 * The live backend's own logic (src/lib/backend/live.ts) with a stubbed
 * Connection: nothing here reaches a network. Builders and reads are the
 * SDK's (tested in sdk/test); what the app adds is explanation, the cluster
 * check, program status, mint labels and the cluster clock.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assertCluster, associatedTokenAddress, GENESIS_HASHES as SDK_GENESIS_HASHES, idlCodecs, KNOWN_ACCOUNTS, payoutAddress, PROGRAM_IDS, WSOL_MINT, type MarketSnapshot } from "@noisedlabs/sdk";
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { TransactionFailedError } from "../src/lib/backend/errors";
import { activeGuard, backend as live, explainFailure, failedProgram, GENESIS_HASHES, guardMintWarning, guardRecipientWarnings } from "../src/lib/backend/live";

const code = (program: "launchpad" | "vault" | "hook" | "shield", name: string): number => {
  const e = (idlCodecs()[program].idl.errors ?? []).find((x) => x.name === name);
  if (e === undefined) throw new Error(`no ${program} error ${name}`);
  return e.code;
};

/** A Connection that only has the methods a test provides. */
function stub(methods: Record<string, unknown>): Connection {
  return methods as unknown as Connection;
}

function signedTransfer(): { tx: Transaction; payer: Keypair } {
  const payer = Keypair.generate();
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.sign(payer);
  return { tx, payer };
}

describe("failure explanations", () => {
  it("names program errors from the IDLs, innermost failing program first", () => {
    const c = code("launchpad", "NotCommitWindow");
    const logs = [
      `Program ${PROGRAM_IDS.launchpad.toBase58()} invoke [1]`,
      `Program log: AnchorError occurred. Error Code: NotCommitWindow.`,
      `Program ${PROGRAM_IDS.launchpad.toBase58()} failed: custom program error: 0x${c.toString(16)}`,
    ];
    expect(failedProgram(logs)).toEqual({ programId: PROGRAM_IDS.launchpad.toBase58(), code: c });
    const x = explainFailure("Transaction simulation failed: Error processing Instruction 0", logs);
    expect(x.errorCode).toEqual({ program: "noised_launchpad", code: c, name: "NotCommitWindow" });
    expect(x.error).toMatch(/^noised_launchpad: .*\(NotCommitWindow, \d+\)$/);

    // A hook refusal inside a DBC swap is attributed to the hook, not the outer programs.
    const h = code("hook", "SnipeShield");
    const nested = [
      `Program ${PROGRAM_IDS.hook.toBase58()} failed: custom program error: 0x${h.toString(16)}`,
      `Program ${KNOWN_ACCOUNTS.token2022.toBase58()} failed: custom program error: 0x${h.toString(16)}`,
      `Program ${PROGRAM_IDS.dbc.toBase58()} failed: custom program error: 0x${h.toString(16)}`,
    ];
    expect(explainFailure("x", nested).errorCode?.name).toBe("SnipeShield");
  });

  it("puts runtime and RPC failures in plain words, keeping the raw text", () => {
    expect(explainFailure("AccountNotFound", []).error).toBe("The fee payer has no SOL on this cluster. Fund it first. (AccountNotFound)");
    expect(explainFailure("ProgramAccountNotFound", []).error).toMatch(/not deployed on this cluster/);
    expect(explainFailure('{"InsufficientFundsForRent":{"account_index":2}}', []).error).toMatch(/rent-exempt minimum/);
    expect(explainFailure("Instruction 0 failed", ["Program log: Error: insufficient lamports 5, need 10"]).error).toMatch(/Not enough SOL/);
    // An unknown custom code of an unknown program is not given a made-up name.
    const other = Keypair.generate().publicKey.toBase58();
    expect(explainFailure("custom program error: 0x1", [`Program ${other} failed: custom program error: 0x1`]).errorCode).toBeNull();
  });
});

describe("simulateAndExplain (live)", () => {
  const fee = { getFeeForMessage: async () => ({ context: { slot: 1 }, value: 5_000 }) };

  it("explains a transaction-level error in plain words", async () => {
    const conn = stub({ ...fee, simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: "AccountNotFound", logs: [], unitsConsumed: 0 } }) });
    const r = await live.simulateAndExplain(conn, signedTransfer().tx);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBeNull();
    expect(r.error).toMatch(/^The fee payer has no SOL/);
    expect(r.feeLamports).toBe(5_000n);
    expect(r.unknownPrograms).toEqual([]);
  });

  it("keeps the SDK's IDL-named program errors", async () => {
    const c = code("vault", "InvalidSignature");
    const logs = [`Program ${PROGRAM_IDS.vault.toBase58()} failed: custom program error: 0x${c.toString(16)}`];
    const conn = stub({ ...fee, simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: c }] }, logs } }) });
    const r = await live.simulateAndExplain(conn, signedTransfer().tx);
    expect(r.errorCode).toEqual({ program: "noised_vault", code: c, name: "InvalidSignature" });
  });

  it("lists programs it does not know, so the review refuses to sign", async () => {
    const stranger = Keypair.generate().publicKey;
    const { tx, payer } = signedTransfer();
    tx.add({ programId: stranger, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0) });
    const conn = stub({ ...fee, simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }) });
    const r = await live.simulateAndExplain(conn, tx);
    expect(r.ok).toBe(true);
    expect(r.unknownPrograms.map((p) => p.toBase58())).toEqual([stranger.toBase58()]);
  });

  it("reports an unreachable or rate-limiting endpoint instead of a fake result", async () => {
    const conn = stub({
      ...fee,
      simulateTransaction: async () => {
        throw new Error("failed to simulate transaction: 429 Too Many Requests");
      },
    });
    await expect(live.simulateAndExplain(conn, signedTransfer().tx)).rejects.toThrow(/Simulation could not run: The RPC endpoint is rate-limiting/);
  });
});

describe("sendAndConfirm (live)", () => {
  it("explains a preflight rejection with the program's error name and keeps the logs", async () => {
    const c = code("launchpad", "CapExceeded");
    const logs = [`Program ${PROGRAM_IDS.launchpad.toBase58()} failed: custom program error: 0x${c.toString(16)}`];
    const conn = stub({
      sendRawTransaction: async () => {
        throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: `Transaction simulation failed: Error processing Instruction 0: custom program error: 0x${c.toString(16)}`, logs });
      },
    });
    const err = await live.sendAndConfirm(conn, signedTransfer().tx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionFailedError);
    expect((err as TransactionFailedError).message).toMatch(/^Rejected before broadcast .*CapExceeded/);
    expect((err as TransactionFailedError).errorCode?.name).toBe("CapExceeded");
    expect((err as TransactionFailedError).logs).toEqual(logs);
  });

  it("says when a transaction expired before confirmation", async () => {
    const { tx } = signedTransfer();
    const conn = stub({
      sendRawTransaction: async (raw: Uint8Array) => {
        expect(raw.length).toBeGreaterThan(0);
        return (await import("bs58")).default.encode(tx.signature ?? new Uint8Array());
      },
      confirmTransaction: async () => {
        throw new TransactionExpiredBlockheightExceededError("sig");
      },
    });
    await expect(live.sendAndConfirm(conn, tx)).rejects.toThrow(/not confirmed before its blockhash expired/);
  });

  it("explains a transaction that landed but failed, from its logs", async () => {
    const { tx } = signedTransfer();
    const sig = (await import("bs58")).default.encode(tx.signature ?? new Uint8Array());
    const h = code("hook", "TransfersLocked");
    const conn = stub({
      sendRawTransaction: async () => sig,
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: h }] } } }),
      _rpcRequest: async (method: string) => {
        expect(method).toBe("getTransaction");
        return { result: { meta: { logMessages: [`Program ${PROGRAM_IDS.hook.toBase58()} failed: custom program error: 0x${h.toString(16)}`] } } };
      },
    });
    const err = await live.sendAndConfirm(conn, tx).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^The transaction landed but failed on chain .*TransfersLocked/);
  });
});

describe("cluster check", () => {
  const conn = (hash: string): Connection => stub({ getGenesisHash: async () => hash });

  it("uses the hashes the clusters serve (read live with `solana genesis-hash`), and the SDK's own for mainnet and devnet", async () => {
    expect(GENESIS_HASHES).toEqual({
      mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    });
    expect([GENESIS_HASHES.mainnet, GENESIS_HASHES.devnet]).toEqual([SDK_GENESIS_HASHES.mainnet, SDK_GENESIS_HASHES.devnet]);
    // Real devnet is devnet for the banner and for the SDK's signers alike (SDK 0.5.0 refused it).
    expect((await live.checkCluster(conn("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"), "devnet")).state).toBe("match");
    expect(await assertCluster(conn("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"), "devnet")).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  });

  it("accepts the expected cluster and refuses another", async () => {
    expect((await live.checkCluster(conn(GENESIS_HASHES.devnet), "devnet")).state).toBe("match");
    const wrong = await live.checkCluster(conn(GENESIS_HASHES.devnet), "mainnet");
    expect(wrong.state).toBe("mismatch");
    expect(wrong.detail).toMatch(/targets mainnet, but the RPC endpoint serves devnet/);
    expect((await live.checkCluster(conn(GENESIS_HASHES.mainnet), "devnet")).state).toBe("mismatch");
  });

  it("cannot verify a local cluster, and says when a localnet build talks to a public one", async () => {
    expect((await live.checkCluster(conn("LocaLGenesis11111111111111111111111111111111"), "localnet")).state).toBe("unverified");
    expect((await live.checkCluster(conn(GENESIS_HASHES.mainnet), "localnet")).detail).toMatch(/connected to mainnet/);
  });

  it("reports an unreachable endpoint without blocking", async () => {
    const down = stub({
      getGenesisHash: async () => {
        throw new Error("fetch failed");
      },
    });
    const r = await live.checkCluster(down, "devnet");
    expect(r.state).toBe("error");
    expect(r.detail).toMatch(/could not be reached/);
  });
});

describe("program status", () => {
  it("reads deployment, upgrade authority and last deploy slot from the loader accounts", async () => {
    const programData = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const programAccount = (pd: PublicKey): Buffer => Buffer.concat([Buffer.from([2, 0, 0, 0]), pd.toBuffer()]);
    const programDataAccount = (slot: bigint, auth: PublicKey | null): Buffer => {
      const b = Buffer.alloc(45);
      b.writeUInt32LE(3, 0);
      b.writeBigUInt64LE(slot, 4);
      if (auth) {
        b[12] = 1;
        auth.toBuffer().copy(b, 13);
      }
      return b;
    };
    const loader = KNOWN_ACCOUNTS.bpfLoaderUpgradeable;
    const calls: { keys: string[]; slice: unknown }[] = [];
    const conn = stub({
      getMultipleAccountsInfo: async (keys: PublicKey[], cfg: { dataSlice?: unknown }) => {
        calls.push({ keys: keys.map((k) => k.toBase58()), slice: cfg.dataSlice });
        if (calls.length === 1) {
          return keys.map((k) => {
            if (k.equals(PROGRAM_IDS.launchpad)) return null; // not deployed
            if (k.equals(PROGRAM_IDS.dbc)) return { owner: loader, executable: true, lamports: 1, data: programAccount(programData), rentEpoch: 0 };
            if (k.equals(KNOWN_ACCOUNTS.splToken)) return { owner: new PublicKey("BPFLoader2111111111111111111111111111111111"), executable: true, lamports: 1, data: Buffer.alloc(36), rentEpoch: 0 };
            return null;
          });
        }
        return keys.map(() => ({ owner: loader, executable: false, lamports: 1, data: programDataAccount(445_503_633n, authority), rentEpoch: 0 }));
      },
    });
    const s = await live.programStatuses(conn);
    const by = (id: PublicKey) => s.find((p) => p.programId.equals(id));
    expect(by(PROGRAM_IDS.launchpad)?.state).toBe("missing");
    expect(by(PROGRAM_IDS.dbc)).toMatchObject({ state: "deployed", upgradeable: true, lastDeploySlot: 445_503_633n });
    expect(by(PROGRAM_IDS.dbc)?.upgradeAuthority?.equals(authority)).toBe(true);
    expect(by(KNOWN_ACCOUNTS.splToken)).toMatchObject({ state: "deployed", upgradeable: false });
    // Only the loader headers are fetched, never the program ELFs.
    expect(calls[0]?.slice).toEqual({ offset: 0, length: 36 });
    expect(calls[1]).toEqual({ keys: [programData.toBase58()], slice: { offset: 0, length: 45 } });
  });
});

describe("launches open only once the protocol is initialized", () => {
  const protocol = new PublicKey("BTiVRCENNQB8wnDCbAAoufHX3EgDKG9AioTu3BiDKc5M");
  const reads: { key: string; cfg: unknown }[] = [];
  const conn = (account: { owner: PublicKey; data: Buffer } | null): Connection =>
    stub({
      getAccountInfo: async (key: PublicKey, cfg: unknown) => {
        reads.push({ key: key.toBase58(), cfg });
        return account === null ? null : { ...account, executable: false, lamports: 1, rentEpoch: 0 };
      },
    });

  it("reads the launchpad's Protocol account: missing means not open (mainnet before initialize_protocol)", async () => {
    reads.length = 0;
    expect(await live.protocolInitialized(conn(null))).toBe(false);
    // One 8-byte read of the Protocol PDA, nothing else.
    expect(reads).toEqual([{ key: protocol.toBase58(), cfg: { commitment: "confirmed", dataSlice: { offset: 0, length: 8 } } }]);
  });

  it("is open only for an account the launchpad owns there (lamports sent to the address do not count)", async () => {
    expect(await live.protocolInitialized(conn({ owner: PROGRAM_IDS.launchpad, data: Buffer.alloc(8, 1) }))).toBe(true);
    expect(await live.protocolInitialized(conn({ owner: SystemProgram.programId, data: Buffer.alloc(0) }))).toBe(false);
    expect(await live.protocolInitialized(conn({ owner: PROGRAM_IDS.launchpad, data: Buffer.alloc(0) }))).toBe(false);
  });

  it("throws when the RPC cannot answer (the app then offers a retry, never the forms)", async () => {
    const down = stub({
      getAccountInfo: async () => {
        throw new Error("fetch failed");
      },
    });
    await expect(live.protocolInitialized(down)).rejects.toThrow(/fetch failed/);
  });
});

describe("mint info", () => {
  const base = (supply: bigint, decimals: number): Buffer => {
    const b = Buffer.alloc(82);
    b.writeBigUInt64LE(supply, 36);
    b[44] = decimals;
    b[45] = 1;
    return b;
  };
  const metadataTlv = (mint: PublicKey, name: string, symbol: string): Buffer => {
    const str = (s: string): Buffer => {
      const bytes = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length);
      return Buffer.concat([len, bytes]);
    };
    const body = Buffer.concat([Buffer.alloc(32), mint.toBuffer(), str(name), str(symbol), str("ipfs://x"), Buffer.alloc(4)]);
    const header = Buffer.alloc(4);
    header.writeUInt16LE(19, 0);
    header.writeUInt16LE(body.length, 2);
    return Buffer.concat([header, body]);
  };

  it("labels wSOL and Token-2022 metadata, sanitized", async () => {
    const mint = Keypair.generate().publicKey;
    const t22 = Buffer.concat([base(1_000n, 6), Buffer.alloc(83), Buffer.from([1]), metadataTlv(mint, "Aegis‮\u0000 Token", "AEGS")]);
    const conn = stub({
      getAccountInfo: async (k: PublicKey) => {
        if (k.equals(WSOL_MINT)) return { owner: KNOWN_ACCOUNTS.splToken, executable: false, lamports: 1, data: base(0n, 9), rentEpoch: 0 };
        if (k.equals(mint)) return { owner: KNOWN_ACCOUNTS.token2022, executable: false, lamports: 1, data: t22, rentEpoch: 0 };
        return null;
      },
    });
    expect(await live.getMintInfo(conn, WSOL_MINT)).toMatchObject({ symbol: "wSOL", decimals: 9 });
    const m = await live.getMintInfo(conn, mint);
    expect(m).toMatchObject({ symbol: "AEGS", name: "Aegis Token", decimals: 6, supply: 1_000n });
    expect(m?.tokenProgram.equals(KNOWN_ACCOUNTS.token2022)).toBe(true);
    expect(await live.getMintInfo(conn, Keypair.generate().publicKey)).toBeNull();
  });

  it("is null for accounts that are not mints", async () => {
    const tokenAccount = Buffer.alloc(165);
    const conn = stub({ getAccountInfo: async () => ({ owner: KNOWN_ACCOUNTS.splToken, executable: false, lamports: 1, data: tokenAccount, rentEpoch: 0 }) });
    expect(await live.getMintInfo(conn, Keypair.generate().publicKey)).toBeNull();
    const system = stub({ getAccountInfo: async () => ({ owner: SystemProgram.programId, executable: false, lamports: 1, data: Buffer.alloc(0), rentEpoch: 0 }) });
    expect(await live.getMintInfo(system, Keypair.generate().publicKey)).toBeNull();
  });
});

describe("cluster clock", () => {
  it("reads Clock::unix_timestamp and nothing else", async () => {
    let slice: unknown;
    const conn = stub({
      getAccountInfo: async (_k: PublicKey, cfg: { dataSlice?: unknown }) => {
        slice = cfg.dataSlice;
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(1_791_000_000n);
        return { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), executable: false, lamports: 1, data: b, rentEpoch: 0 };
      },
    });
    expect(await live.chainUnixTime(conn)).toBe(1_791_000_000);
    expect(slice).toEqual({ offset: 32, length: 8 });
    expect(await live.chainUnixTime(stub({ getAccountInfo: async () => null }))).toBeNull();
  });
});

describe("demo-only controls", () => {
  it("do nothing in a live build", () => {
    expect(live.demoMints()).toEqual([]);
    expect(() => live.resetDemoState()).toThrow(/live build/);
  });
});

describe("Launch Guard warnings for vaults (what the hook does to deposits and payouts)", () => {
  const launch = (o: { status?: "live" | "configured"; hookActive?: boolean; p2pLocked?: boolean; maxWalletBps?: number } = {}): NonNullable<Parameters<typeof activeGuard>[0]> => ({
    status: o.status ?? "live",
    guardEndTs: 2_000n,
    p2pLocked: o.p2pLocked ?? true,
    maxWalletBps: o.maxWalletBps ?? 100,
    market: { hookActive: o.hookActive ?? true } as MarketSnapshot,
  });

  it("apply only to a live launch whose hook is active, until the guard ends", () => {
    expect(activeGuard(null, 1_000)).toBeNull();
    expect(activeGuard(launch({ status: "configured" }), 1_000)).toBeNull();
    expect(activeGuard(launch({ hookActive: false }), 1_000)).toBeNull();
    expect(activeGuard(launch(), 2_000)).toBeNull();
    expect(activeGuard(launch(), 1_999)).toEqual({ guardEndTs: 2_000n, p2pLocked: true, maxWalletBps: 100 });
  });

  it("say that a p2p lock delays deposits and payout deliveries, never the withdrawal", () => {
    const g = activeGuard(launch(), 1_000);
    expect(guardMintWarning(g)).toMatch(/deposits into a vault and payout deliveries are refused until then\. A withdrawal still executes/);
    expect(guardMintWarning(activeGuard(launch({ p2pLocked: false }), 1_000))).toBeNull();
    expect(guardMintWarning(null)).toBeNull();
    const w = guardRecipientWarnings(g);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/the withdrawal executes now and reserves the payout, but delivering it \(release or release_to\) is refused until then/);
    expect(w[1]).toMatch(/max-wallet cap \(1% of the supply\)/);
    expect(guardRecipientWarnings(activeGuard(launch({ p2pLocked: false, maxWalletBps: 0 }), 1_000))).toEqual([]);
  });
});

describe("recipient check (the SDK's, with the connected wallet and the token's warnings apart)", () => {
  const mint = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  /** An SPL mint with a freeze authority (82 bytes: no mint authority, 6 decimals, initialized). */
  const freezable = ((): Buffer => {
    const b = Buffer.alloc(82);
    b[44] = 6;
    b[45] = 1;
    b.writeUInt32LE(1, 46);
    Keypair.generate().publicKey.toBuffer().copy(b, 50);
    return b;
  })();
  const conn = stub({
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => (k.equals(mint) ? { owner: KNOWN_ACCOUNTS.splToken, executable: false, lamports: 1, data: freezable, rentEpoch: 0 } : null)),
  });

  it("passes the connected wallet to the SDK: its own token accounts are refused, even before they exist", async () => {
    const wallet = Keypair.generate().publicKey;
    const ata = associatedTokenAddress(wallet, mint, KNOWN_ACCOUNTS.splToken);
    const anonymous = await live.checkRecipient(conn, ata, mint, vault);
    expect(anonymous.ok).toBe(true);
    expect(anonymous.offCurveConfirmation).toMatch(/payout is lost forever/);
    const named = await live.checkRecipient(conn, ata, mint, vault, { wallet });
    expect(named.ok).toBe(false);
    expect(named.refusals.join(" ")).toMatch(/your connected wallet's own token account/);
  });

  it("keeps the token's warnings apart from the recipient's", async () => {
    const c = await live.checkRecipient(conn, Keypair.generate().publicKey, mint, vault);
    expect(c).toMatchObject({ ok: true, refusals: [], recipientWarnings: [], offCurveConfirmation: null });
    expect(c.mintWarnings.join(" ")).toMatch(/Freeze authority .* delay payouts/);
  });
});

describe("pending-withdrawal search (the SDK's findPendingWithdrawal, which replaced the app's v3 search)", () => {
  interface Key {
    id: string;
    q: number;
    k: string;
    keyId: string;
  }
  interface V {
    withdrawals: {
      name: string;
      inputs: { mint: string; sequence: string; destinationOwner: string; maxAmount: string };
      genesisKey: Key;
      key: Key;
      addresses: { vault: string; payout: string };
      signature: string;
      openVaultIx: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
      v1WithdrawRelease: { wire: string };
    }[];
  }
  const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../../tests/integration/vectors/vault_withdraw.json", import.meta.url)), "utf8")) as V;
  const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
  const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

  for (const c of vectors.withdrawals) {
    it(`finds the Rust-built withdraw + release of a failed transaction and stops at open_vault (${c.name})`, async () => {
      const vault = new PublicKey(c.addresses.vault);
      const mint = new PublicKey(c.inputs.mint);
      const sequence = BigInt(c.inputs.sequence);
      expect(payoutAddress(vault, sequence).toBase58()).toBe(c.addresses.payout);
      const codec = idlCodecs().vault;
      const [, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), mint.toBytes(), fromHex(c.genesisKey.keyId)], PROGRAM_IDS.vault);
      const vaultData = Buffer.concat([
        Buffer.from(codec.accountDiscriminator("Vault")),
        Buffer.from(
          codec.encodeType("Vault", {
            version: 4,
            bump,
            mint,
            genesisKeyId: fromHex(c.genesisKey.keyId),
            sequence,
            keyId: fromHex(c.key.keyId),
            keyIdent: fromHex(c.key.id),
            keyQ: c.key.q,
            keyK: fromHex(c.key.k),
            reserved: 0n,
          }),
        ),
      ]);
      // The transaction that opened the vault: the history boundary for sequence 0.
      const open = new Transaction({ feePayer: new PublicKey(c.openVaultIx.accounts[0]?.pubkey ?? ""), blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 });
      open.add(
        new TransactionInstruction({
          programId: new PublicKey(c.openVaultIx.programId),
          keys: c.openVaultIx.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
          data: Buffer.from(fromHex(c.openVaultIx.data)),
        }),
      );
      const txs: Record<string, { err: unknown; bytes: Uint8Array }> = {
        failedWithdraw: { err: { InstructionError: [1, { Custom: 6001 }] }, bytes: fromHex(c.v1WithdrawRelease.wire) },
        opened: { err: null, bytes: open.serialize({ requireAllSignatures: false, verifySignatures: false }) },
      };
      const conn = stub({
        getAccountInfo: async (k: PublicKey) => (k.equals(vault) ? { owner: PROGRAM_IDS.vault, executable: false, lamports: 1, data: vaultData, rentEpoch: 0 } : null),
        getSignaturesForAddress: async (address: PublicKey, opts: { before?: string }) => {
          if (opts.before !== undefined) return [];
          if (address.equals(payoutAddress(vault, sequence))) return [{ signature: "failedWithdraw", err: txs.failedWithdraw?.err }];
          if (address.equals(vault)) return [{ signature: "failedWithdraw", err: txs.failedWithdraw?.err }, { signature: "opened", err: null }];
          return [];
        },
        _rpcRequest: async (method: string, [sig]: [string]) => {
          expect(method).toBe("getTransaction");
          const t = txs[sig];
          return { result: t ? { slot: 7, meta: { err: t.err }, transaction: [Buffer.from(t.bytes).toString("base64"), "base64"] } : null };
        },
      });
      const search = await live.findPendingWithdrawal(conn, vault);
      expect(search.vault.sequence).toBe(sequence);
      expect(search.pending?.txSignature).toBe("failedWithdraw");
      // Nothing older than the vault's opening can hold a signature of its current key.
      expect(search.complete).toBe(true);
      expect(search.note).toBeNull();
      expect(search.all).toHaveLength(1);
      expect(search.pending?.failed).toBe(true);
      expect(search.pending?.destinationOwner.toBase58()).toBe(c.inputs.destinationOwner);
      expect(search.pending?.maxAmount).toBe(BigInt(c.inputs.maxAmount));
      expect(hex(search.pending?.signature ?? new Uint8Array())).toBe(c.signature);
    });
  }

  it("says the search is incomplete when the RPC cannot return the history", async () => {
    const c = vectors.withdrawals[0];
    if (!c) throw new Error("no vector");
    const vault = new PublicKey(c.addresses.vault);
    const mint = new PublicKey(c.inputs.mint);
    const codec = idlCodecs().vault;
    const [, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), mint.toBytes(), fromHex(c.genesisKey.keyId)], PROGRAM_IDS.vault);
    const data = Buffer.concat([
      Buffer.from(codec.accountDiscriminator("Vault")),
      Buffer.from(
        codec.encodeType("Vault", {
          version: 4,
          bump,
          mint,
          genesisKeyId: fromHex(c.genesisKey.keyId),
          sequence: BigInt(c.inputs.sequence),
          keyId: fromHex(c.key.keyId),
          keyIdent: fromHex(c.key.id),
          keyQ: c.key.q,
          keyK: fromHex(c.key.k),
          reserved: 0n,
        }),
      ),
    ]);
    const conn = stub({
      getAccountInfo: async () => ({ owner: PROGRAM_IDS.vault, executable: false, lamports: 1, data, rentEpoch: 0 }),
      getSignaturesForAddress: async (_a: PublicKey, opts: { before?: string }) => (opts.before === undefined ? [{ signature: "x", err: null }] : []),
      _rpcRequest: async () => ({ result: null }),
    });
    const search = await live.findPendingWithdrawal(conn, vault);
    expect(search.pending).toBeNull();
    expect(search.complete).toBe(false);
    expect(search.note).toMatch(/could not/i);
  });
});

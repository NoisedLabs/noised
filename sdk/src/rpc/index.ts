/**
 * RPC helpers: balances, simulation with human-readable errors, and sending
 * legacy transactions or raw v1 wire bytes.
 */
import { PublicKey, Transaction, VersionedTransaction, type Commitment, type Connection } from "@solana/web3.js";
import { Buffer } from "buffer";

import { encodeBase58 } from "../codec/base58.js";
import { PROGRAM_IDS } from "../constants.js";
import { associatedTokenAddress } from "../pda.js";
import { decodeV1Transaction, V1_MAX_TRANSACTION_SIZE } from "../tx/v1.js";
import { parseMint, parseTokenAccount } from "../token/mint.js";
import type { ProgramInvocation, SimulationReport } from "../types.js";
import { explainTransactionError, KNOWN_PROGRAMS } from "./errors.js";
import { getAccount, getAccounts, rpcRequest } from "./fetch.js";

export { customErrorCode, explainProgramError, explainTransactionError, failedProgramFromLogs, KNOWN_PROGRAMS, PLAIN_ERROR_MESSAGES, plainErrorMessage, programLabel } from "./errors.js";

/** Legacy / v0 packet limit. */
export const LEGACY_MAX_TRANSACTION_SIZE = 1232;
/** Base fee per signature (lamports) on every public cluster. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

export type AnyTransaction = Transaction | Uint8Array;

/**
 * The rent-exempt minimum of an account of `size` bytes, read from the
 * cluster (`getMinimumBalanceForRentExemption`), never hard-coded: rent is a
 * cluster parameter.
 */
export async function rentExemptLamports(conn: Connection, size: number): Promise<bigint> {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("size must be a non-negative integer");
  const lamports = await conn.getMinimumBalanceForRentExemption(size, "confirmed");
  if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error("the RPC returned an invalid rent-exempt minimum");
  return BigInt(lamports);
}

export async function getSolBalance(conn: Connection, owner: PublicKey): Promise<bigint> {
  return BigInt(await conn.getBalance(owner, "confirmed"));
}

/** Balance of `owner`'s canonical ATA for `mint` (0 if it does not exist). */
export async function getTokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const mintAcc = await getAccount(conn, mint);
  if (mintAcc === null) throw new Error(`mint ${mint.toBase58()} does not exist`);
  const ata = associatedTokenAddress(owner, mint, parseMint(mintAcc.owner, mintAcc.data).programId);
  const [acc] = await getAccounts(conn, [ata]);
  return acc === null || acc === undefined || acc.data.length === 0 ? 0n : parseTokenAccount(acc.owner, acc.data).amount;
}

export async function getTokenSupply(conn: Connection, mint: PublicKey): Promise<bigint> {
  const acc = await getAccount(conn, mint);
  if (acc === null) throw new Error(`mint ${mint.toBase58()} does not exist`);
  return parseMint(acc.owner, acc.data).supply;
}

export async function getMintInfo(conn: Connection, mint: PublicKey): Promise<{ decimals: number; supply: bigint; tokenProgram: PublicKey }> {
  const acc = await getAccount(conn, mint);
  if (acc === null) throw new Error(`mint ${mint.toBase58()} does not exist`);
  const m = parseMint(acc.owner, acc.data);
  return { decimals: m.decimals, supply: m.supply, tokenProgram: m.programId };
}

interface RpcSimulateValue {
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number | null;
}

/** Index of the failing top-level instruction of a transaction error (`{InstructionError: [i, …]}`). */
export function failedInstructionIndex(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("InstructionError" in err)) return null;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  return Array.isArray(ie) && typeof ie[0] === "number" ? ie[0] : null;
}

function invocations(programIds: readonly PublicKey[]): { programs: ProgramInvocation[]; unknown: PublicKey[] } {
  const seen = new Set<string>();
  const programs: ProgramInvocation[] = [];
  const unknown: PublicKey[] = [];
  for (const p of programIds) {
    const id = p.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    const name = KNOWN_PROGRAMS.get(id) ?? null;
    programs.push({ programId: p, name });
    if (name === null) unknown.push(p);
  }
  return { programs, unknown };
}

/**
 * Simulate without signatures (blockhash replaced) and explain the outcome.
 * Never signs anything. `unknownPrograms` lists top-level programs this SDK
 * does not recognise: a wallet should refuse to sign those transactions.
 */
export async function simulateAndExplain(conn: Connection, tx: AnyTransaction, commitment: Commitment = "confirmed"): Promise<SimulationReport> {
  if (!(tx instanceof Transaction)) {
    const d = decodeV1Transaction(tx);
    const { programs, unknown } = invocations(d.instructions.map((ix) => d.accountKeys[ix.programIdIndex]!));
    const res = await rpcRequest(conn)<{ value: RpcSimulateValue }>("simulateTransaction", [
      Buffer.from(tx).toString("base64"),
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment },
    ]);
    if (res.error !== undefined || res.result === undefined) throw new Error(`simulateTransaction failed: ${res.error?.message ?? "no result"}`);
    const v = res.result.value;
    const logs = v.logs ?? [];
    const explained = v.err === null ? null : explainTransactionError(v.err, logs);
    const n = d.header.numRequiredSignatures;
    const writable = d.accountKeys.filter((_, i) =>
      i < n ? i < n - d.header.numReadonlySigned : i < d.accountKeys.length - d.header.numReadonlyUnsigned,
    );
    return {
      ok: v.err === null,
      error: explained?.error ?? null,
      errorCode: explained?.errorCode ?? null,
      failedInstruction: failedInstructionIndex(v.err),
      logs,
      unitsConsumed: v.unitsConsumed ?? null,
      programs,
      unknownPrograms: unknown,
      signers: d.accountKeys.slice(0, n),
      writableAccounts: writable,
      feeLamports: LAMPORTS_PER_SIGNATURE * BigInt(n) + (d.priorityFeeLamports ?? 0n),
      sizeBytes: tx.length,
      sizeLimit: V1_MAX_TRANSACTION_SIZE,
      format: "v1",
    };
  }
  const legacy = tx;
  const message = legacy.compileMessage();
  const { programs, unknown } = invocations(legacy.instructions.map((ix) => ix.programId));
  const sim = await conn.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true, commitment });
  const logs = sim.value.logs ?? [];
  const explained = sim.value.err === null ? null : explainTransactionError(sim.value.err, logs);
  let fee: bigint | null = null;
  try {
    const f = (await conn.getFeeForMessage(message, commitment)).value;
    fee = f === null ? null : BigInt(f);
  } catch {
    fee = null;
  }
  return {
    ok: sim.value.err === null,
    error: explained?.error ?? null,
    errorCode: explained?.errorCode ?? null,
    failedInstruction: failedInstructionIndex(sim.value.err),
    logs,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    programs,
    unknownPrograms: unknown,
    signers: message.accountKeys.slice(0, message.header.numRequiredSignatures),
    writableAccounts: message.accountKeys.filter((_, i) => message.isAccountWritable(i)),
    feeLamports: fee,
    sizeBytes: legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
    sizeLimit: LEGACY_MAX_TRANSACTION_SIZE,
    format: "legacy",
  };
}

export interface SendOptions {
  /** Block height after which the blockhash expires; default: the current block height at `preflightCommitment` (default `confirmed`) + 150. */
  lastValidBlockHeight?: number;
  skipPreflight?: boolean;
  /**
   * The commitment to WAIT for (default `confirmed`; `finalized` waits about
   * 13 s longer). It does not change the preflight (`preflightCommitment`).
   */
  commitment?: Commitment;
  /**
   * The commitment of the preflight simulation and of the default expiry
   * height (default `confirmed`, the commitment every builder of this SDK
   * fetches its blockhash at). Use the commitment the transaction's
   * blockhash was fetched at: a preflight at a later commitment than the
   * blockhash (`finalized` for a `confirmed` blockhash, `confirmed` for a
   * `processed` one) can refuse a transaction that would land fine
   * (BlockhashNotFound).
   */
  preflightCommitment?: Commitment;
}

/**
 * The default commitment of the preflight simulation and of the default
 * expiry height. Every builder fetches its blockhash at `confirmed`, so a
 * preflight at `finalized` could run against a bank that does not know that
 * blockhash yet (BlockhashNotFound) for a transaction that would land fine.
 */
const PREFLIGHT_COMMITMENT: Commitment = "confirmed";

/**
 * Send a fully signed legacy transaction or raw signed v1 wire bytes and
 * wait for confirmation at `opts.commitment` (default `confirmed`). Returns
 * the transaction signature. Throws if the transaction failed or its
 * blockhash expired.
 *
 * The preflight simulation runs at `opts.preflightCommitment` (default
 * `confirmed`, the builders' own blockhash commitment), whatever
 * `opts.commitment` asks to wait for: a `finalized` preflight would refuse a
 * fresh `confirmed` blockhash with BlockhashNotFound. A transaction built
 * elsewhere with a `processed` blockhash passes `preflightCommitment:
 * "processed"`.
 *
 * For a PQ withdrawal: if this throws because the blockhash expired or the
 * network dropped it, rebuild with `buildWithdrawTx` from the SAME stored
 * signature and send again; never sign a new message with the same key.
 */
export async function sendAndConfirm(conn: Connection, tx: AnyTransaction, opts: SendOptions = {}): Promise<string> {
  const commitment = opts.commitment ?? "confirmed";
  const preflightCommitment = opts.preflightCommitment ?? PREFLIGHT_COMMITMENT;
  let raw: Uint8Array;
  let signature: string;
  let blockhash: string;
  let lastValidBlockHeight = opts.lastValidBlockHeight;
  if (tx instanceof Transaction) {
    if (tx.recentBlockhash === undefined) throw new Error("transaction has no recent blockhash");
    raw = tx.serialize(); // throws if a required signature is missing or invalid
    signature = encodeBase58(tx.signature!);
    blockhash = tx.recentBlockhash;
    lastValidBlockHeight ??= tx.lastValidBlockHeight;
  } else {
    const d = decodeV1Transaction(tx);
    raw = tx;
    signature = encodeBase58(d.signatures[0]!);
    blockhash = d.recentBlockhash;
  }
  // The blockhash's lifetime counts from the bank it came from (a finalized height lags a confirmed one by ~32 blocks).
  lastValidBlockHeight ??= (await conn.getBlockHeight(preflightCommitment)) + 150;
  const sent = await conn.sendRawTransaction(raw, { skipPreflight: opts.skipPreflight ?? false, preflightCommitment });
  if (sent !== signature) throw new Error(`RPC returned signature ${sent}, expected ${signature}`);
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, commitment);
  if (res.value.err !== null) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

/** The program ids this SDK's builders use, for allowlisting in wallets/UIs. */
export const SDK_PROGRAM_IDS: readonly PublicKey[] = [...Object.values(PROGRAM_IDS)];

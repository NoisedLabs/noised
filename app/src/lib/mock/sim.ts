/**
 * MOCK runtime: every builder registers what its transaction would do; this
 * module simulates and "lands" transactions against the mock state with
 * realistic logs, fees and failures.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeV1Transaction, v1TransactionId, VAULT, verifyV1Signatures, type AnyTransaction, type SimulationReport } from "@noisedlabs/sdk";
import { Transaction, type PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { TransactionFailedError } from "../backend/errors";
import { programLabelOf as programLabel, withRuntimeHint } from "../display";
import { explainAnyProgramError } from "../programErrors";
import { toHex } from "./bytes";
import { chain } from "./chain";
import { addSol, latency, nowSecs, persist, solBalance, type MockState } from "./store";

export const LAMPORTS_PER_SIGNATURE = 5_000n;
const LEGACY_LIMIT = 1232;

export type SimFailure =
  /**
   * `via`: programs strictly between the top-level program and the failing one (CPI chain).
   * `instruction`: index of the failing top-level instruction (default: the first one of the main program).
   */
  | { kind: "program"; program: PublicKey; code: number; via?: PublicKey[]; instruction?: number }
  | { kind: "runtime"; message: string; instruction?: number };

export interface Effect {
  /** Instruction name logged by the main program, e.g. "Commit". */
  label: string;
  /** Program whose instruction is the point of the transaction. */
  program: PublicKey;
  computeUnits: number;
  payer: PublicKey;
  /** Rent for accounts this transaction creates (paid by the payer). */
  rent: bigint;
  /** Lamports leaving the payer besides fee and rent (e.g. SOL wrapped for a commit). */
  solOut: bigint;
  check(s: MockState, now: number): SimFailure | null;
  apply(s: MockState, now: number): void;
  /** Extra "Program log:" lines on success. */
  logs?: (s: MockState) => string[];
  /** Called when the transaction lands, succeeded or failed (after `apply` on success): e.g. a vault's withdraw history. */
  landed?: (s: MockState, outcome: { txSignature: string; failed: boolean; slot: number }) => void;
}

const effects = new Map<string, Effect>();

export { TransactionFailedError };

function isV1(tx: AnyTransaction): tx is Uint8Array {
  return tx instanceof Uint8Array;
}

function fingerprint(tx: AnyTransaction): string {
  const message = isV1(tx) ? decodeV1Transaction(tx).message : tx.serializeMessage();
  return toHex(sha256(message));
}

/** Built-but-unsent transactions are forgotten oldest first (quotes build one per keystroke). */
const MAX_EFFECTS = 500;

export function register(tx: AnyTransaction, effect: Effect): void {
  effects.set(fingerprint(tx), effect);
  while (effects.size > MAX_EFFECTS) {
    const oldest = effects.keys().next();
    if (oldest.done === true) break;
    effects.delete(oldest.value);
  }
}

interface TxShape {
  programs: PublicKey[];
  /** Program of each top-level instruction, in order. */
  instructionPrograms: PublicKey[];
  signers: PublicKey[];
  writable: PublicKey[];
  sizeBytes: number;
  sizeLimit: number;
  format: "legacy" | "v1";
}

function uniq(keys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const id = k.toBase58();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function shape(tx: AnyTransaction): TxShape {
  if (isV1(tx)) {
    const d = decodeV1Transaction(tx);
    const n = d.accountKeys.length;
    const { numRequiredSignatures: sig, numReadonlySigned: roSig, numReadonlyUnsigned: roUnsig } = d.header;
    const writable = d.accountKeys.filter((_, i) => (i < sig ? i < sig - roSig : i < n - roUnsig));
    const instructionPrograms = d.instructions.map((ix) => d.accountKeys[ix.programIdIndex]).filter((k): k is PublicKey => k !== undefined);
    return {
      programs: uniq(instructionPrograms),
      instructionPrograms,
      signers: d.accountKeys.slice(0, sig),
      writable,
      sizeBytes: tx.length,
      sizeLimit: VAULT.V1_MAX_TX_BYTES,
      format: "v1",
    };
  }
  const payer = tx.feePayer;
  const signers: PublicKey[] = payer ? [payer] : [];
  const writable: PublicKey[] = payer ? [payer] : [];
  for (const ix of tx.instructions) {
    for (const k of ix.keys) {
      if (k.isSigner) signers.push(k.pubkey);
      if (k.isWritable) writable.push(k.pubkey);
    }
  }
  return {
    programs: uniq(tx.instructions.map((ix) => ix.programId)),
    instructionPrograms: tx.instructions.map((ix) => ix.programId),
    signers: uniq(signers),
    writable: uniq(writable),
    sizeBytes: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
    sizeLimit: LEGACY_LIMIT,
    format: "legacy",
  };
}

function feeOf(sh: TxShape): bigint {
  return LAMPORTS_PER_SIGNATURE * BigInt(sh.signers.length);
}

/** Fee, rent and SOL the payer needs, then the transaction's own checks. */
function evaluate(s: MockState, now: number, effect: Effect, sh: TxShape): SimFailure | null {
  const need = feeOf(sh) + effect.rent + effect.solOut;
  const have = solBalance(s, effect.payer);
  if (have === 0n) return { kind: "runtime", message: "Attempt to debit an account but found no record of a prior credit." };
  if (have < need) return { kind: "runtime", message: `Transfer: insufficient lamports ${have}, need ${need}`, instruction: mainInstruction(effect, sh) };
  return effect.check(s, now);
}

/** Index of the first top-level instruction of the effect's main program. */
function mainInstruction(effect: Effect, sh: TxShape): number {
  const i = sh.instructionPrograms.findIndex((p) => p.equals(effect.program));
  return i < 0 ? 0 : i;
}

/** The failing top-level instruction (null for transaction-level failures such as an unfunded fee payer). */
function failedInstructionOf(f: SimFailure, effect: Effect, sh: TxShape): number | null {
  if (f.kind === "runtime" && f.instruction === undefined) return f.message.includes("no record of a prior credit") ? null : mainInstruction(effect, sh);
  return f.instruction ?? mainInstruction(effect, sh);
}

function shortId(k: PublicKey): string {
  return k.toBase58();
}

/** Name and message of a failure, in the same words the SDK's `simulateAndExplain` uses. */
function explain(f: SimFailure): { error: string; errorCode: SimulationReport["errorCode"] } {
  if (f.kind === "runtime") return { error: withRuntimeHint(f.message), errorCode: null };
  const e = explainAnyProgramError(f.program.toBase58(), f.code);
  const program = programLabel(f.program) ?? f.program.toBase58();
  if (e === null) return { error: `${program} failed with custom error ${f.code}`, errorCode: { program, code: f.code, name: `Custom(${f.code})` } };
  return { error: `${e.program}: ${e.message} (${e.name}, ${f.code})`, errorCode: { program: e.program, code: f.code, name: e.name } };
}

function buildLogs(sh: TxShape, effect: Effect | undefined, failure: SimFailure | null, s: MockState): { logs: string[]; units: number } {
  const logs: string[] = [];
  let units = 0;
  for (const program of sh.programs) {
    const id = shortId(program);
    const isMain = effect !== undefined && program.equals(effect.program);
    const name = programLabel(program);
    const base = isMain ? effect.computeUnits : name === "system_program" ? 150 : name === "spl_associated_token_account" ? 4_400 : 3_100;
    logs.push(`Program ${id} invoke [1]`);
    if (isMain) logs.push(`Program log: Instruction: ${effect.label}`);
    if (isMain && failure !== null) {
      if (failure.kind === "program") {
        const cpi = failure.program.equals(program) ? [] : [...(failure.via ?? []), failure.program];
        cpi.forEach((p, depth) => logs.push(`Program ${shortId(p)} invoke [${depth + 2}]`));
        const e = explainAnyProgramError(failure.program.toBase58(), failure.code);
        logs.push(`Program log: AnchorError occurred. Error Code: ${e?.name ?? "Custom"}. Error Number: ${failure.code}. Error Message: ${e?.message ?? "custom error"}.`);
        // The failing program and every caller fail in turn, innermost first.
        for (const p of [program, ...cpi].reverse()) logs.push(`Program ${shortId(p)} failed: custom program error: 0x${failure.code.toString(16)}`);
      } else {
        logs.push(`Program log: ${failure.message}`);
        logs.push(`Program ${id} failed: ${failure.message}`);
      }
      units += Math.round(base * 0.55);
      return { logs, units };
    }
    if (isMain && effect.logs) for (const line of effect.logs(s)) logs.push(`Program log: ${line}`);
    const used = Math.round(base * (0.92 + Math.random() * 0.12));
    units += used;
    logs.push(`Program ${id} consumed ${used} of ${isMain ? 400_000 : 200_000} compute units`);
    logs.push(`Program ${id} success`);
  }
  return { logs, units };
}

export async function simulate(tx: AnyTransaction): Promise<SimulationReport> {
  await latency("simulate");
  const s = chain();
  const sh = shape(tx);
  const effect = effects.get(fingerprint(tx));
  const unknownPrograms = sh.programs.filter((p) => programLabel(p) === null);
  const programs = sh.programs.map((p) => ({ programId: p, name: programLabel(p) }));
  const base = {
    programs,
    unknownPrograms,
    signers: sh.signers,
    writableAccounts: sh.writable,
    feeLamports: feeOf(sh),
    sizeBytes: sh.sizeBytes,
    sizeLimit: sh.sizeLimit,
    format: sh.format,
  };
  if (!effect) {
    return {
      ...base,
      ok: false,
      error: "This transaction was not built by this app, so it cannot be simulated or sent here.",
      errorCode: null,
      failedInstruction: null,
      logs: [],
      unitsConsumed: null,
    };
  }
  const failure = evaluate(s, nowSecs(), effect, sh);
  const { logs, units } = buildLogs(sh, effect, failure, s);
  if (failure) {
    const { error, errorCode } = explain(failure);
    return { ...base, ok: false, error, errorCode, failedInstruction: failedInstructionOf(failure, effect, sh), logs, unitsConsumed: units };
  }
  return { ...base, ok: true, error: null, errorCode: null, failedInstruction: null, logs, unitsConsumed: units };
}

/** A v1 transaction's id is its fee payer's signature; the demo account signs nothing, so legacy ones get a random id. */
function transactionId(tx: AnyTransaction): string {
  return isV1(tx) ? v1TransactionId(tx) : bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
}

export async function send(tx: AnyTransaction): Promise<string> {
  await latency("send");
  const s = chain();
  const sh = shape(tx);
  const fp = fingerprint(tx);
  const effect = effects.get(fp);
  if (!effect) throw new TransactionFailedError("Rejected: this transaction was not built by this app.", [], null);
  if (s.landed[fp] !== undefined) {
    throw new TransactionFailedError("This exact transaction already landed (already processed).", [], null);
  }
  if (isV1(tx)) {
    const decoded = decodeV1Transaction(tx);
    if (!verifyV1Signatures(decoded)) throw new TransactionFailedError("Rejected: a transaction signature does not verify.", [], null);
  } else if (tx instanceof Transaction && tx.signatures.some((sig) => sig.signature !== null) && !tx.verifySignatures(false)) {
    throw new TransactionFailedError("Rejected: a transaction signature does not verify.", [], null);
  }
  const now = nowSecs();
  const txSignature = transactionId(tx);
  const failure = evaluate(s, now, effect, sh);
  if (failure) {
    const { logs } = buildLogs(sh, effect, failure, s);
    const { error, errorCode } = explain(failure);
    // A failed transaction still lands and pays its fee, if its fee payer can pay it.
    if (solBalance(s, effect.payer) >= feeOf(sh)) {
      addSol(s, effect.payer, -feeOf(sh));
      s.landed[fp] = now;
      s.slot += 2 + Math.floor(Math.random() * 3);
      effect.landed?.(s, { txSignature, failed: true, slot: s.slot });
      persist();
    }
    throw new TransactionFailedError(error, logs, errorCode);
  }
  addSol(s, effect.payer, -(feeOf(sh) + effect.rent));
  effect.apply(s, now);
  s.landed[fp] = now;
  s.slot += 2 + Math.floor(Math.random() * 3);
  effect.landed?.(s, { txSignature, failed: false, slot: s.slot });
  persist();
  return txSignature;
}

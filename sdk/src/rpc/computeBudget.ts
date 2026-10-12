/**
 * Priority fees and compute-unit limits.
 *
 * Every builder that takes `ComputeBudgetOptions` sets a tight compute-unit
 * limit by default (measured, with margin) and adds a priority fee only when
 * asked. Legacy transactions carry ComputeBudget instructions
 * (SetComputeUnitLimit, then SetComputeUnitPrice); v1 transactions ignore
 * those instructions and carry config words instead: the limit, and the
 * priority fee as a total in lamports (`priorityFeeLamports`). A tighter
 * limit means a higher priority per compute unit for the same fee, and a
 * smaller fee for the same price.
 *
 * To size a limit from the real transaction: build it with a generous limit,
 * `simulateComputeUnits` it (units used + 10%, rounded up), then rebuild with
 * that limit. A transaction that runs out of compute units fails; for a
 * signed PQ withdrawal that means a rebuild and re-broadcast of the SAME
 * signature with a higher limit (the limit is not part of what the key
 * signed), never a new signature.
 */
import { ComputeBudgetProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";

import { isU64 } from "../codec/bytes.js";
import { simulateAndExplain, type AnyTransaction } from "./index.js";

/** The runtime's per-transaction compute-unit ceiling. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/** Priority fee and compute-unit limit of a transaction builder. */
export interface ComputeBudgetOptions {
  /**
   * Priority fee in micro-lamports per compute unit (SetComputeUnitPrice).
   * Default: none. For a v1 transaction it becomes the priority-fee config
   * word: `ceil(computeUnitPrice * computeUnitLimit / 1,000,000)` lamports.
   */
  computeUnitPrice?: bigint | undefined;
  /** Compute-unit limit (1..=1,400,000). Default: the builder's measured tight limit. */
  computeUnitLimit?: number | undefined;
}

/** `opts.computeUnitLimit` checked, or `fallback`. */
export function computeUnitLimitOf(opts: ComputeBudgetOptions | undefined, fallback: number): number {
  const limit = opts?.computeUnitLimit ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMPUTE_UNIT_LIMIT) {
    throw new RangeError(`computeUnitLimit must be an integer in 1..=${MAX_COMPUTE_UNIT_LIMIT}`);
  }
  return limit;
}

/** `opts.computeUnitPrice` checked (micro-lamports per compute unit), or null when unset. */
export function computeUnitPriceOf(opts: ComputeBudgetOptions | undefined): bigint | null {
  const price = opts?.computeUnitPrice;
  if (price === undefined) return null;
  if (!isU64(price)) throw new RangeError("computeUnitPrice must be a u64 bigint (micro-lamports per compute unit)");
  return price;
}

/** The total priority fee (lamports) of `price` micro-lamports per unit over `limit` units, rounded up like the runtime. */
export function priorityFeeLamports(price: bigint, limit: number): bigint {
  if (!isU64(price)) throw new RangeError("computeUnitPrice must be a u64 bigint");
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("compute-unit limit must be a non-negative integer");
  return (price * BigInt(limit) + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
}

/**
 * The ComputeBudget instructions of a legacy transaction: SetComputeUnitLimit
 * (`opts.computeUnitLimit` or `defaultLimit`), then SetComputeUnitPrice when
 * `opts.computeUnitPrice` is set. Put them first.
 */
export function computeBudgetInstructions(opts: ComputeBudgetOptions | undefined, defaultLimit: number): TransactionInstruction[] {
  const units = computeUnitLimitOf(opts, defaultLimit);
  const price = computeUnitPriceOf(opts);
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (price !== null) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  return ixs;
}

/**
 * A tight compute-unit limit for `tx` (legacy, or v1 wire bytes): simulate
 * it as built and return the units it used plus 10%, rounded up (at most
 * 1,400,000). Throws if the simulation fails or reports no units: a failing
 * transaction cannot be sized. Build `tx` with a generous limit first.
 */
export async function simulateComputeUnits(conn: Connection, tx: AnyTransaction): Promise<number> {
  const sim = await simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`cannot size the compute-unit limit: the transaction fails in simulation (${sim.error ?? "unknown error"})`);
  const used = sim.unitsConsumed;
  if (used === null || !Number.isInteger(used) || used <= 0) throw new Error("cannot size the compute-unit limit: the simulation reported no compute units");
  return Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.ceil((used * 11) / 10));
}

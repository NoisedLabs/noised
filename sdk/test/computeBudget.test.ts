/**
 * Priority fees and compute-unit limits: the ComputeBudget instructions of
 * legacy builders, the v1 priority-fee word, and sizing a limit from a
 * simulation (`simulateComputeUnits`: units used + 10%, rounded up).
 */
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { KNOWN_ACCOUNTS } from "../src/constants.js";
import { computeBudgetInstructions, computeUnitLimitOf, computeUnitPriceOf, MAX_COMPUTE_UNIT_LIMIT, priorityFeeLamports, simulateComputeUnits } from "../src/rpc/computeBudget.js";
import { compileV1Message, signV1Message } from "../src/tx/v1.js";
import { key, MockConnection } from "./helpers.js";

describe("compute budget", () => {
  it("SetComputeUnitLimit, then SetComputeUnitPrice only when a price is given", () => {
    const [limit, ...rest] = computeBudgetInstructions({}, 80_000);
    expect(rest).toEqual([]);
    expect(limit!.programId.equals(KNOWN_ACCOUNTS.computeBudget)).toBe(true);
    expect(Buffer.from(limit!.data).toString("hex")).toBe(Buffer.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }).data).toString("hex"));
    const both = computeBudgetInstructions({ computeUnitPrice: 12_345n, computeUnitLimit: 61_000 }, 80_000);
    expect(both.map((i) => Buffer.from(i.data).toString("hex"))).toEqual([
      Buffer.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 61_000 }).data).toString("hex"),
      Buffer.from(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345n }).data).toString("hex"),
    ]);
    // The price is a u64 of micro-lamports per unit; the limit 1..=1,400,000.
    expect(computeBudgetInstructions({ computeUnitPrice: 2n ** 64n - 1n }, 1).length).toBe(2);
    for (const bad of [{ computeUnitLimit: 0 }, { computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT + 1 }, { computeUnitLimit: 2.5 }, { computeUnitPrice: -1n }, { computeUnitPrice: 2n ** 64n }, { computeUnitPrice: 5 as unknown as bigint }]) {
      expect(() => computeBudgetInstructions(bad, 10_000)).toThrow(RangeError);
    }
    expect(() => computeBudgetInstructions({}, 0)).toThrow(RangeError);
    expect([computeUnitLimitOf(undefined, 7), computeUnitPriceOf(undefined), computeUnitPriceOf({ computeUnitPrice: 0n })]).toEqual([7, null, 0n]);
  });

  it("the v1 priority fee is the runtime's total: ceil(price * limit / 1,000,000) lamports", () => {
    expect(priorityFeeLamports(0n, 200_000)).toBe(0n);
    expect(priorityFeeLamports(1n, 1)).toBe(1n);
    expect(priorityFeeLamports(5_000n, 200_000)).toBe(1_000n);
    expect(priorityFeeLamports(5_000n, 123_456)).toBe(618n);
    expect(priorityFeeLamports(1_000_000n, 3)).toBe(3n);
    expect(priorityFeeLamports(2n ** 64n - 1n, 1_400_000)).toBe(((2n ** 64n - 1n) * 1_400_000n + 999_999n) / 1_000_000n);
    expect(() => priorityFeeLamports(-1n, 1)).toThrow(RangeError);
    expect(() => priorityFeeLamports(1n, -1)).toThrow(RangeError);
  });

  it("simulateComputeUnits: units used + 10%, rounded up, for legacy and v1; a failing transaction cannot be sized", async () => {
    const conn = new MockConnection();
    let units: number | null = 12_345;
    let err: unknown = null;
    conn.simulate = () => ({ context: { slot: 1 }, value: { err, logs: [], unitsConsumed: units } });
    conn.rpc = () => ({ result: { context: { slot: 1 }, value: { err, logs: [], unitsConsumed: units } } });
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(3));
    const legacy = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: key("cb/to"), lamports: 1 }));
    legacy.feePayer = payer.publicKey;
    legacy.recentBlockhash = conn.blockhash;
    expect(await simulateComputeUnits(conn.asConnection(), legacy)).toBe(13_580);
    const v1 = signV1Message(compileV1Message(payer.publicKey, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: key("cb/to"), lamports: 1 })], conn.blockhash, { computeUnitLimit: 1_400_000, loadedAccountsDataSizeLimit: 65_536 }), [payer]);
    units = 100_000;
    expect(await simulateComputeUnits(conn.asConnection(), v1)).toBe(110_000);
    units = 1_399_999;
    expect(await simulateComputeUnits(conn.asConnection(), v1)).toBe(MAX_COMPUTE_UNIT_LIMIT);
    units = null;
    await expect(simulateComputeUnits(conn.asConnection(), v1)).rejects.toThrow(/no compute units/);
    units = 5_000;
    err = { InstructionError: [0, "ComputationalBudgetExceeded"] };
    await expect(simulateComputeUnits(conn.asConnection(), legacy)).rejects.toThrow(/fails in simulation/);
  });
});

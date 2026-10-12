/**
 * The autopilot's run rules as this server applies them: everything comes
 * from @noisedlabs/sdk 0.9 (node statuses, `planRun`, `planPartial`,
 * `planMaxTip`, `planValue`, `takeTipRaw`, the decoded `partial_spent`); the
 * server only feeds it the live account. These check that it does so
 * faithfully: a chosen amount is decided exactly as the SDK's own status
 * decides it, partial buybacks shrink the run's cap, and the tip follows the
 * program's rules.
 */
import { AUTOPILOT, fetchDueNodes, planPartial, planSpent, type DueNodes } from "@noisedlabs/sdk";
import { describe, expect, it } from "vitest";

import { expectedTip, keeperFloorOf, planStep, programErrorText } from "../src/tools/runRules.js";
import { NOW, OPERATOR, SOL, world, type WorldOptions } from "./world.js";

async function dueOf(o: WorldOptions = {}): Promise<DueNodes> {
  const w = world(o);
  const d = await fetchDueNodes(w.conn.asConnection(), w.launch, { poolFeeBps: 100 });
  if (d === null) throw new Error("no autopilot");
  return d;
}

describe("the program's error names", () => {
  it("carry their code (6000 + index); other names stay as given", () => {
    expect(programErrorText("RemainderTooSmall")).toBe("RemainderTooSmall (6041)");
    expect(programErrorText("NoRecipientAccount")).toBe("NoRecipientAccount (6042)");
    expect(programErrorText("NotALaunch")).toBe("NotALaunch (6000)");
    expect(programErrorText("ConstraintSeeds")).toBe("ConstraintSeeds");
  });
});

describe("planStep: the program's decision for a chosen amount, on the live account", () => {
  it("agrees with the SDK's own status: its suggested amount is accepted, and partial exactly when the status says so", async () => {
    for (const poolSol of [200n * SOL, 20n * SOL]) {
      const d = await dueOf({ poolSol });
      const st = d.statuses[0]!;
      expect(st.due).toBe(true);
      const p = planStep(d, 0, st.amount < st.maxAmount ? st.amount : null, null);
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      expect(planSpent(p.value)).toBe(st.amount);
      expect(planPartial(p.value)).toBe(st.partial);
    }
  });

  it("a keeper's buyback: the floor (1% of the pool's SOL), the remainder rule (6041), the cap", async () => {
    // A 20 SOL pool: the floor is 0.2 SOL; step 0 moves at most 1 SOL a run.
    const d = await dueOf({ poolSol: 20n * SOL });
    expect(keeperFloorOf(d)).toBe(SOL / 5n);
    const at = (amount: bigint | null) => planStep(d, 0, amount, null);
    expect(at(SOL / 2n)).toMatchObject({ ok: true, value: { kind: "buyback", amountIn: SOL / 2n, partial: true } });
    expect(at(SOL)).toMatchObject({ ok: true, value: { kind: "buyback", amountIn: SOL, partial: false } });
    expect(at((SOL * 8n) / 10n)).toMatchObject({ ok: true, value: { partial: true } });
    expect(at((SOL * 9n) / 10n)).toEqual({ ok: false, error: "RemainderTooSmall" });
    expect(at(SOL / 10n)).toEqual({ ok: false, error: "AmountTooSmall" });
    expect(at(SOL + 1n)).toEqual({ ok: false, error: "InvalidAmount" });
    expect(at(null)).toMatchObject({ ok: true, value: { amountIn: SOL, partial: false } });
  });

  it("partial buybacks already made (partial_spent, decoded by the SDK) shrink the run's cap", async () => {
    const d = await dueOf({ partialSpent: { 0: (SOL * 6n) / 10n } });
    expect(d.view.autopilot.partialSpent[0]).toBe((SOL * 6n) / 10n);
    expect(d.statuses[0]).toMatchObject({ due: true, cap: (SOL * 4n) / 10n, maxAmount: (SOL * 4n) / 10n });
    expect(planStep(d, 0, null, null)).toMatchObject({ ok: true, value: { amountIn: (SOL * 4n) / 10n, partial: false } });
    expect(planStep(d, 0, SOL / 2n, null)).toEqual({ ok: false, error: "InvalidAmount" });
  });

  it("fixed steps take no amount; operator-only steps need the operator's signature and an amount", async () => {
    const d = await dueOf();
    expect(planStep(d, 1, 1n, null)).toEqual({ ok: false, error: "AmountNotAllowed" });
    expect(planStep(d, 1, null, null)).toMatchObject({ ok: true, value: { kind: "burn" } });
    expect(planStep(d, 3, 100_000_000n, null)).toEqual({ ok: false, error: "WrongOperator" });
    expect(planStep(d, 3, null, OPERATOR)).toEqual({ ok: false, error: "InvalidAmount" });
    expect(planStep(d, 3, 100_000_000n, OPERATOR)).toMatchObject({ ok: true, value: { kind: "buyback", amountIn: 100_000_000n, partial: false } });
    expect(planStep(d, 9, null, null)).toEqual({ ok: false, error: "NoSuchNode" });
  });
});

describe("expectedTip: the program's tip rules", () => {
  const plan = (d: DueNodes, i: number, amount: bigint | null) => {
    const p = planStep(d, i, amount, i === 3 ? OPERATOR : null);
    if (!p.ok) throw new Error(p.error);
    return p.value;
  };

  it("TIP_LAMPORTS for a full run; a partial buyback earns its share (planMaxTip); a tenth of what moved", async () => {
    const d = await dueOf({ poolSol: 20n * SOL });
    expect(expectedTip(d, 0, plan(d, 0, null), 0n)).toBe(AUTOPILOT.TIP_LAMPORTS);
    expect(expectedTip(d, 0, plan(d, 0, SOL / 4n), 0n)).toBe(AUTOPILOT.TIP_LAMPORTS / 4n);
    expect(expectedTip(d, 3, plan(d, 3, 500_000n), 0n)).toBe(50_000n);
  });

  it("a payout's tip counts only what reaches recipients (the kept shares of skipped ones do not)", async () => {
    const d = await dueOf();
    const p = plan(d, 2, null);
    expect(p.kind).toBe("distribute");
    expect(expectedTip(d, 2, p, 0n)).toBe(AUTOPILOT.TIP_LAMPORTS);
    expect(expectedTip(d, 2, p, planSpent(p) - 400_000n)).toBe(40_000n);
  });

  it("a burn before graduation earns nothing; the day's tip cap bounds it", async () => {
    const early = await dueOf({ graduated: false });
    expect(early.statuses[1]).toMatchObject({ due: true });
    expect(expectedTip(early, 1, plan(early, 1, null), 0n)).toBe(0n);

    const d = await dueOf();
    const today = BigInt(NOW) - (BigInt(NOW) % BigInt(AUTOPILOT.TIP_EPOCH_SECS));
    d.view.autopilot.tipEpochStart = today;
    d.view.autopilot.tipsInEpoch = AUTOPILOT.TIP_EPOCH_CAP - 30_000n;
    expect(expectedTip(d, 0, plan(d, 0, null), 0n)).toBe(30_000n);
    d.view.autopilot.tipEpochStart = today - 86_400n; // yesterday's tips do not count
    expect(expectedTip(d, 0, plan(d, 0, null), 0n)).toBe(AUTOPILOT.TIP_LAMPORTS);
  });
});

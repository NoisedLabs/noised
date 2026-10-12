/**
 * Simple mode (LAYER_V1 §B.2): every slider stop and every card writes draft strings that `convertDraft` turns into
 * exactly the intended parameters, and those parameters pass the SDK's `validateLaunchParams` (the program's policy),
 * from every preset. Also: the controls recognise the presets' own settings, and the goal slider keeps the batch caps
 * inside the policy when the goal moves.
 */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { convertDraft, draftFromPreset, type Draft } from "../src/pages/create/draft";
import {
  AFTER_FEES,
  BATCH_STOPS_SECS,
  batchPatch,
  evenShares,
  evenSplit,
  FEE_STOPS_BPS,
  feeIsSimple,
  feePatch,
  GOAL_STOPS_SOL,
  goalPatch,
  GUARD_STOPS_SECS,
  guardPatch,
  limitsSentence,
  mulDecimal,
  nearestIndex,
  plainDuration,
  PROTECTIONS,
  protectionOf,
  protectionPatch,
  RISES,
  risePatch,
  selectedRise,
  twoWaySplit,
} from "../src/pages/create/simple";
import { DBC, feeSummary, POLICY, PRESETS, priceFromSqrtPrice, validateLaunchParams, type LaunchParamsInput, type PresetName } from "../src/lib/noised";

const wallets = [0, 1, 2, 3].map(() => Keypair.generate().publicKey.toBase58());
const identity = new Uint8Array(32).fill(7);
const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];
const ready = (name: PresetName): Draft => ({ ...draftFromPreset(name), name: "Aegis", symbol: "AEGS", recipients: [{ wallet: wallets[0] ?? "", pct: "100" }] });
const apply = (d: Draft, patch: Partial<Draft>): Draft => ({ ...d, ...patch });

/** The draft's parameters, which must pass the policy with no input error. */
function params(d: Draft): LaunchParamsInput {
  const conv = convertDraft(d, identity, null);
  expect(conv.inputErrors).toEqual({});
  expect(conv.policyErrors).toEqual([]);
  const p = conv.params;
  if (p === null) throw new Error("no params");
  expect(validateLaunchParams(p)).toEqual({ ok: true, errors: [] });
  return p;
}

describe("Simple mode: price curve", () => {
  it("every goal stop is inside the policy and becomes exactly that threshold, from every preset", () => {
    expect(GOAL_STOPS_SOL.length).toBeGreaterThan(5);
    for (const name of PRESET_NAMES) {
      for (const sol of GOAL_STOPS_SOL) {
        const d = apply(ready(name), goalPatch(ready(name), sol));
        const p = params(d);
        expect(p.migrationQuoteThreshold).toBe(BigInt(sol) * POLICY.LAMPORTS_PER_SOL);
        expect(p.migrationQuoteThreshold >= POLICY.MIN_THRESHOLD && p.migrationQuoteThreshold <= POLICY.MAX_THRESHOLD).toBe(true);
      }
    }
  });

  it("a bigger goal raises a per-wallet batch cap that would fall under 1/200 of the batch (fails closed otherwise)", () => {
    // Community: 2 SOL per wallet for a 250 SOL goal. At 1,000 SOL the floor is 5 SOL.
    const before = ready("community");
    expect(protectionOf(before)?.id).toBe("community");
    const naive = apply(before, { thresholdSol: "1000" });
    expect(validateLaunchParams(convertDraft(naive, identity, null).params as LaunchParamsInput).errors.join(" ")).toMatch(/batchWalletCap/);
    const d = apply(before, goalPatch(before, 1000));
    const p = params(d);
    expect(p.batchWalletCap).toBeGreaterThanOrEqual(p.migrationQuoteThreshold / 200n);
    // The card stays chosen: the cap follows the goal.
    expect(protectionOf(d)?.id).toBe("community");
    // A total cap that no longer fits the goal goes back to "the whole goal".
    const capped = apply(ready("fair"), { batchTotalCapSol: "50" });
    expect(params(apply(capped, goalPatch(capped, 20))).batchTotalCap).toBe(0n);
  });

  it("every rise card designs a curve whose graduation price is exactly that many times the start", () => {
    for (const name of PRESET_NAMES) {
      for (const r of RISES) {
        const d = apply(ready(name), risePatch(ready(name), r.times));
        expect(selectedRise(d)).toBe(r.id);
        const p = params(d);
        const start = priceFromSqrtPrice(p.sqrtStartPrice, p.tokenDecimal);
        // designCurve: the first point is the graduation price (the second is headroom past it).
        const end = priceFromSqrtPrice(p.curve[0]?.sqrtPrice ?? 0n, p.tokenDecimal);
        expect(end / start).toBeCloseTo(r.times, 3);
      }
    }
    // The presets' own prices are not one of the cards: none is shown as chosen.
    expect(selectedRise(ready("fair"))).toBeNull();
  });

  it("every fee tier after graduation is one of DAMM v2's options", () => {
    expect(AFTER_FEES.map((f) => f.option)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const f of AFTER_FEES) expect(params(apply(ready("fair"), { migrationFeeOption: String(f.option) })).migrationFeeOption).toBe(f.option);
  });

  it("multiplies decimal prices exactly", () => {
    expect(mulDecimal("0.00000003", 5)).toBe("0.00000015");
    expect(mulDecimal("0.00000003", 25)).toBe("0.00000075");
    expect(mulDecimal("0.00000004", 25)).toBe("0.000001");
    expect(mulDecimal("1.5", 10)).toBe("15");
    expect(mulDecimal("abc", 5)).toBe("");
  });
});

describe("Simple mode: fees", () => {
  it("every fee stop is a flat fee of exactly that size with a dynamic fee, under the 10% ceiling", () => {
    for (const bps of FEE_STOPS_BPS) {
      const d = apply(ready("fair"), feePatch(bps));
      expect(feeIsSimple(d)).toBe(true);
      const p = params(d);
      expect(p.baseFee).toEqual({ cliffFeeNumerator: (BigInt(bps) * DBC.FEE_DENOMINATOR) / 10_000n, firstFactor: 0, secondFactor: 0n, thirdFactor: 0n, baseFeeMode: 0 });
      expect(p.dynamicFee).not.toBeNull();
      const s = feeSummary(p);
      if (s === null) throw new Error("no fee summary");
      expect(s.floorFeeNumerator).toBeGreaterThanOrEqual(DBC.MIN_FEE_NUMERATOR);
      expect(s.floorFeeNumerator + s.maxDynamicFeeNumerator).toBeLessThanOrEqual((BigInt(POLICY.MAX_TRADING_FEE_BPS) * DBC.FEE_DENOMINATOR) / 10_000n);
    }
    // The presets' fees are slider stops.
    for (const name of PRESET_NAMES) expect(feeIsSimple(ready(name))).toBe(true);
  });

  it("splits fees between 1 to 4 wallets into shares that add up to exactly 100%", () => {
    for (let n = 1; n <= POLICY.MAX_RECIPIENTS; n++) {
      const recipients = evenSplit(wallets.slice(0, n).map((wallet) => ({ wallet, pct: "0" })));
      const p = params({ ...ready("fair"), recipients });
      expect(p.recipients.reduce((a, r) => a + r.bps, 0)).toBe(10_000);
      expect(evenShares(n).length).toBe(n);
    }
    for (let first = 1; first <= 99; first++) {
      const recipients = twoWaySplit(
        wallets.slice(0, 2).map((wallet) => ({ wallet, pct: "0" })),
        first,
      );
      expect(params({ ...ready("fair"), recipients }).recipients.map((r) => r.bps)).toEqual([first * 100, 10_000 - first * 100]);
    }
  });
});

describe("Simple mode: launch rules", () => {
  it("every batch length and every early-limits length is accepted, and the limits never end before the batch can run", () => {
    for (const name of PRESET_NAMES) {
      for (const b of BATCH_STOPS_SECS) {
        for (const g of GUARD_STOPS_SECS) {
          let d = apply(ready(name), guardPatch(g));
          d = apply(d, batchPatch(d, b));
          const p = params(d);
          expect(p.openDelaySecs).toBe(b);
          expect(p.guardSecs).toBe(g);
          expect(p.guardSecs).toBeGreaterThanOrEqual(b + POLICY.EXECUTION_GRACE_SECS);
        }
      }
    }
    expect(BATCH_STOPS_SECS[0]).toBe(POLICY.MIN_OPEN_DELAY);
    expect(BATCH_STOPS_SECS[BATCH_STOPS_SECS.length - 1]).toBe(POLICY.MAX_OPEN_DELAY);
    expect(GUARD_STOPS_SECS[GUARD_STOPS_SECS.length - 1]).toBe(POLICY.MAX_GUARD_SECS);
  });

  it("a longer batch lengthens early limits that would end too soon (the policy refuses them otherwise)", () => {
    const short = apply(ready("turbo"), { guardSecs: "900" });
    expect(convertDraft(apply(short, { openDelaySecs: "1800" }), identity, null).policyErrors.join(" ")).toMatch(/guardSecs/);
    const d = apply(short, batchPatch(short, 1800));
    expect(params(d).guardSecs).toBeGreaterThanOrEqual(1800 + POLICY.EXECUTION_GRACE_SECS);
  });

  it("every protection card is accepted for every goal and recognised again", () => {
    for (const name of PRESET_NAMES) {
      for (const sol of GOAL_STOPS_SOL) {
        for (const prot of PROTECTIONS) {
          const base = apply(ready(name), goalPatch(ready(name), sol));
          const d = apply(base, protectionPatch(base, prot));
          const p = params(d);
          expect(p.maxWalletBps).toBe(prot.maxWalletBps);
          expect(p.maxBuyBps).toBe(prot.maxBuyBps);
          expect(p.p2pLocked).toBe(prot.p2pLocked);
          expect(p.batchWalletCap === 0n).toBe(prot.capDivisor === null);
          expect(protectionOf(d)?.id).toBe(prot.id);
        }
      }
    }
    // Each preset's own settings are one of the cards.
    expect(protectionOf(ready("turbo"))?.id).toBe("light");
    expect(protectionOf(ready("fair"))?.id).toBe("balanced");
    expect(protectionOf(ready("community"))?.id).toBe("community");
  });

  it("says what the limits do in plain words", () => {
    expect(limitsSentence(ready("fair"))).toBe("no wallet can hold more than 1% of the supply and no single buy can take more than 0.5%");
    expect(limitsSentence(ready("community"))).toBe("no wallet can hold more than 2% of the supply, no single buy can take more than 1% and tokens cannot move between wallets");
    expect(limitsSentence({ maxWalletPct: "0", maxBuyPct: "0", p2pLocked: false })).toBe("there are no limits on wallets");
    expect(plainDuration(60)).toBe("1 minute");
    expect(plainDuration(300)).toBe("5 minutes");
    expect(plainDuration(259_200)).toBe("72 hours");
  });

  it("snaps a value set under Advanced to the nearest stop", () => {
    expect(nearestIndex(BATCH_STOPS_SECS, 250)).toBe(BATCH_STOPS_SECS.indexOf(300));
    expect(nearestIndex(GUARD_STOPS_SECS, 3600)).toBe(0);
  });
});

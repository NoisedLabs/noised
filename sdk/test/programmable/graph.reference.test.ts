/**
 * The autopilot's observation window and reference price, mirrored from
 * programs/noised-autopilot/src/reference.rs: the same cases as the Rust
 * host tests (reference_tests.rs), with the same numbers.
 */
import { describe, expect, it } from "vitest";

import {
  AUTOPILOT,
  bucketOf,
  buybackCap,
  buybackMinOut,
  emptyObservations,
  followReference,
  keeperFloor,
  newPriceState,
  observationWindow,
  priceQ64,
  recordObservation,
  tokenValue,
  withinPremium,
} from "../../src/programmable/index.js";
import type { ObsBucket, PriceState } from "../../src/programmable/index.js";

const T0 = 1_800_000_000 - (1_800_000_000 % 900);
const R = 1n << 70n;
const SCALE = 36_000_000n;

const state = (reference: bigint, allowance: bigint, at: number): PriceState => ({
  ...newPriceState(reference),
  allowance,
  allowanceAt: at,
});

describe("observations (reference.rs observe / seen)", () => {
  it("keep the lowest and highest per bucket", () => {
    const o = emptyObservations();
    recordObservation(o, T0 + 10, 500n);
    const b0 = bucketOf(T0);
    expect(o[0]).toEqual({ index: b0, firstAt: T0 + 10, min: 500n, max: 500n });
    expect(o[1].min).toBe(0n);
    recordObservation(o, T0 + 20, 700n);
    recordObservation(o, T0 + 30, 400n);
    recordObservation(o, T0 + 899, 600n);
    expect([o[0].min, o[0].max, o[0].firstAt]).toEqual([400n, 700n, T0 + 10]);
    recordObservation(o, T0 + 40, 0n);
    expect([o[0].min, o[0].max]).toEqual([400n, 700n]);
    recordObservation(o, T0 + 900, 800n);
    expect([o[1].index, o[1].min, o[1].max]).toEqual([b0, 400n, 700n]);
    expect(o[0]).toEqual({ index: b0 + 1, firstAt: T0 + 900, min: 800n, max: 800n });
    recordObservation(o, T0 + 2_700, 900n);
    expect(o[0].index).toBe(b0 + 3);
    expect(o[1].min).toBe(0n);
    recordObservation(o, T0 + 100, 50n);
    expect([o[0].index, o[0].min, o[0].max]).toEqual([b0 + 3, 50n, 900n]);
    const neg = emptyObservations();
    recordObservation(neg, -1, 5n);
    expect(neg[0].index).toBe(-1);
  });

  it("count once they span a minute, for the current and previous bucket", () => {
    const o = emptyObservations();
    recordObservation(o, T0 + 100, 500n);
    expect(observationWindow(o, T0 + 100)).toBeNull();
    expect(observationWindow(o, T0 + 159)).toBeNull();
    expect(observationWindow(o, T0 + 160)).toEqual({ min: 500n, max: 500n });
    recordObservation(o, T0 + 170, 300n);
    expect(observationWindow(o, T0 + 170)).toEqual({ min: 300n, max: 500n });
    expect(observationWindow(o, T0 + 1_799)).toEqual({ min: 300n, max: 500n });
    expect(observationWindow(o, T0 + 1_800)).toBeNull();
    recordObservation(o, T0 + 950, 900n);
    expect(observationWindow(o, T0 + 950)).toEqual({ min: 300n, max: 900n });
    const both = emptyObservations();
    recordObservation(both, T0 + 100, 700n);
    recordObservation(both, T0 + 950, 600n);
    recordObservation(both, T0 + 960, 650n);
    expect(observationWindow(both, T0 + 960)).toEqual({ min: 600n, max: 700n });
    const edge = emptyObservations();
    recordObservation(edge, T0 + 899, 500n);
    recordObservation(edge, T0 + 900, 600n);
    expect(observationWindow(edge, T0 + 900)).toBeNull();
    expect(observationWindow(edge, T0 + 959)).toEqual({ min: 500n, max: 600n });
    expect(observationWindow(emptyObservations(), T0)).toBeNull();
  });

  it("bound a buyback by the lower of the reference and the lowest observed", () => {
    expect(buybackCap(R, null)).toBeNull();
    expect(buybackCap(R, { min: R / 2n, max: R * 2n })).toBe(R / 2n);
    expect(buybackCap(R, { min: R * 2n, max: R * 3n })).toBe(R);
  });
});

describe("the reference (reference.rs follow)", () => {
  it("rises from an allowance only rises spend", () => {
    const up = (r: bigint): bigint => r + (r * AUTOPILOT.REF_ALLOWANCE_MAX) / SCALE;
    const p = state(R, 0n, 0);
    const above = { min: R * 2n, max: R * 3n };
    expect(followReference(p, above, T0)).toBe(true);
    expect(p.reference).toBe(up(R));
    expect(p.reference).toBe((R * 10_243n) / 10_000n);
    expect(p.allowance <= 1n).toBe(true);
    const moved = p.reference;
    expect(followReference(p, above, T0)).toBe(false);
    for (let t = 1; t <= 60; t++) followReference(p, null, T0 + t);
    const a = p.allowance;
    expect(a >= 60n * 243n && a <= 60n * 243n + 1n).toBe(true);
    expect(followReference(p, { min: moved - 1n, max: moved * 2n }, T0 + 60)).toBe(false);
    expect([p.reference, p.allowance]).toEqual([moved, a]);
    const target = moved + moved / 100_000n;
    expect(followReference(p, { min: target, max: target * 2n }, T0 + 60)).toBe(true);
    expect(p.reference).toBe(target);
    expect(p.allowance).toBe(a - 360n);
    followReference(p, null, T0 + 100 * 3_600);
    expect(p.allowance).toBe(AUTOPILOT.REF_ALLOWANCE_MAX);
    const q = state(R, 5n, T0);
    followReference(q, null, T0 - 10);
    expect([q.allowance, q.allowanceAt]).toEqual([5n, T0]);
  });

  it("falls at once when every observation is below it", () => {
    const p = state(R, 0n, T0);
    expect(followReference(p, { min: R / 10n, max: R / 3n }, T0)).toBe(true);
    expect(p.reference).toBe(R / 3n);
    expect(p.allowance).toBe(0n);
    expect(followReference(p, { min: R / 10n, max: R / 3n }, T0 + 1)).toBe(false);
  });

  it("never overflows (the program's u128) or moves from zero", () => {
    const max = (1n << 128n) - 1n;
    expect(followReference(state(max, AUTOPILOT.REF_ALLOWANCE_MAX, T0), { min: max, max }, T0)).toBe(false);
    expect(followReference(state(0n, AUTOPILOT.REF_ALLOWANCE_MAX, T0), { min: 5n, max: 9n }, T0)).toBe(false);
    const top = (1n << 96n) - 1n;
    const p = state(top, AUTOPILOT.REF_ALLOWANCE_MAX, T0);
    expect(followReference(p, { min: max, max }, T0)).toBe(true);
    expect(p.reference).toBe(top + (top * 243n) / 10_000n);
  });

  it("an attacker who makes every observation walks it at most 5% an hour", () => {
    const p = state(R, 0n, 0);
    let now = T0;
    for (let i = 0; i < 24 * 60; i++) {
      now += 60;
      recordObservation(p.observations, now, p.reference * 10n);
      followReference(p, observationWindow(p.observations, now), now);
    }
    const ratio = Number(p.reference) / Number(R);
    expect(ratio).toBeLessThanOrEqual(Math.exp(0.0243 * 25));
    expect(ratio).toBeLessThanOrEqual(1.0246 ** 25);
    expect(ratio).toBeGreaterThanOrEqual(Math.exp(0.0243 * 23));
    // One honest observation stops it and bounds every buyback.
    const walked = p.reference;
    now += 60;
    recordObservation(p.observations, now, R);
    const w = observationWindow(p.observations, now);
    expect(followReference(p, w, now)).toBe(false);
    expect(p.reference).toBe(walked);
    expect(buybackCap(p.reference, w)).toBe(R);
  });

  it("a single transaction an hour moves nothing", () => {
    const p = state(R, 0n, 0);
    let now = T0;
    for (let i = 0; i < 24; i++) {
      now += 3_600;
      recordObservation(p.observations, now, R * 2n);
      const w = observationWindow(p.observations, now);
      expect(w).toBeNull();
      expect(followReference(p, w, now)).toBe(false);
    }
    expect(p.reference).toBe(R);
  });

  it("nobody can outvote an observation (random histories against a model)", () => {
    let seed = 0xf1n;
    const next = (): bigint => {
      seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & ((1n << 64n) - 1n);
      return seed >> 11n;
    };
    const below = (n: number): number => Number(next() % BigInt(n));
    let rises = 0;
    let falls = 0;
    for (let h = 0; h < 60; h++) {
      const p = state(R, 0n, 0);
      const log: [number, bigint][] = [];
      let now = T0 + below(900);
      let market = R;
      for (let i = 0; i < 200; i++) {
        now += [0, 1, 30, 59, 60, 300, 900, 3_600][below(8)]!;
        if (below(4) === 0) {
          market = (market * BigInt(9_000 + below(2_000))) / 10_000n;
          if (market < 1n << 50n) market = 1n << 50n;
          if (market > 1n << 90n) market = 1n << 90n;
        }
        const spot = below(3) === 0 ? market : (market * BigInt(1 + below(4))) / BigInt(1 + below(2));
        const before: PriceState = { ...p, observations: [{ ...p.observations[0] }, { ...p.observations[1] }] };
        recordObservation(p.observations, now, spot);
        log.push([now, spot]);
        const w = observationWindow(p.observations, now);
        const inWindow = log.filter(([t]) => bucketOf(t) >= bucketOf(now) - 1);
        const lowest = inWindow.reduce((m, [, s]) => (s < m ? s : m), inWindow[0]![1]);
        const oldest = Math.min(...inWindow.map(([t]) => t));
        expect(w !== null).toBe(now - oldest >= 60);
        if (w !== null) {
          expect(w.min).toBe(lowest);
          expect(w.max).toBe(inWindow.reduce((m, [, s]) => (s > m ? s : m), 0n));
        }
        const cap = buybackCap(p.reference, w);
        if (cap !== null) expect(cap <= lowest && cap <= p.reference).toBe(true);
        followReference(p, w, now);
        if (p.reference > before.reference) {
          rises++;
          expect(w!.min > before.reference && p.reference <= w!.min).toBe(true);
        } else if (p.reference < before.reference) {
          falls++;
          expect(w!.max < before.reference && p.reference === w!.max).toBe(true);
        }
      }
    }
    expect(rises).toBeGreaterThan(20);
    expect(falls).toBeGreaterThan(20);
  });
});

describe("buyback math (price.rs)", () => {
  it("the premium boundary is exact on prices", () => {
    const r = 1n << 70n;
    expect(withinPremium(r + (r / 1_000_000n) * 14_889n, r, 300)).toBe(true);
    expect(withinPremium(r + (r / 1_000_000n) * 14_890n, r, 300)).toBe(false);
    expect(withinPremium(r / 2n, r, 300)).toBe(true);
    expect(withinPremium(1n << 96n, r, 300)).toBe(false);
  });

  it("min out, token value, keeper floor", () => {
    const one = 1n << 64n;
    expect(buybackMinOut(1_000_000_000n, one, 0)).toBe(1_000_000_000n);
    expect(buybackMinOut(1_000_000_000n, one, 500)).toBe((1_000_000_000n * 10_000n) / 10_500n);
    expect(buybackMinOut(1_000n, (1n << 32n) - 1n, 300)).toBeNull();
    expect(buybackMinOut(1n << 63n, 1n << 40n, 0)).toBeNull();
    expect(priceQ64(1n << 96n)).toBeNull();
    expect(tokenValue(12_345n, one)).toBe(12_345n);
    expect(tokenValue(1n, 1n << 60n)).toBe(0n);
    expect(tokenValue((1n << 64n) - 1n, (1n << 96n) - 1n)).toBe((1n << 64n) - 1n);
    expect(tokenValue(5n, 1n << 96n)).toBe(0n);
    expect(keeperFloor(10_000_000_000n)).toBe(100_000_000n);
    expect(keeperFloor(99n)).toBe(0n);
  });

  it("the constants are the program's", () => {
    expect(AUTOPILOT.TIP_MAX_SHARE_BPS).toBe(1_000);
    expect(AUTOPILOT.KEEPER_MIN_POOL_BPS).toBe(100);
    expect([AUTOPILOT.OBS_BUCKET_SECS, AUTOPILOT.OBS_MIN_SPAN_SECS]).toEqual([900, 60]);
    expect(AUTOPILOT.REF_UP_SQRT_BPS_PER_HOUR).toBe(243);
    expect(AUTOPILOT.REF_ALLOWANCE_MAX).toBe(243n * 3_600n);
    const b: ObsBucket = emptyObservations()[0];
    expect(b.min).toBe(0n);
  });
});

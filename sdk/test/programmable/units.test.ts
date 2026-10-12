/** Exact unit conversions, hashes and golden byte layouts. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PXG1,
  PXR1,
  ProgError,
  ZERO_HASH,
  compileGraph,
  compileRules,
  decodeBase58,
  encodeBase58,
  every,
  burn,
  formatBps,
  formatDate,
  formatDuration,
  formatDurationLong,
  formatSol,
  formatTokens,
  graph,
  graphHash,
  isqrt,
  parseDecimal,
  priceToSqrtPriceQ64,
  rules,
  rulesHash,
  rulesHashHex,
  sqrtPriceQ64ToPrice,
  sqrtPriceQ64ToPriceText,
  toBps,
  toHex,
  toLamports,
  toSeconds,
  toTokenUnits,
  toUnix,
  when,
} from "../../src/programmable/index.js";
import { Rng } from "./helpers.js";

const sha = (tag: string, b: Uint8Array): string => createHash("sha256").update(Buffer.from(tag)).update(b).digest("hex");

describe("durations", () => {
  it("parses compact, spaced and long forms", () => {
    expect(toSeconds("90s")).toBe(90);
    expect(toSeconds("2m")).toBe(120);
    expect(toSeconds("1h30m")).toBe(5_400);
    expect(toSeconds("1 hour 30 minutes")).toBe(5_400);
    expect(toSeconds("1.5h")).toBe(5_400);
    expect(toSeconds("1d")).toBe(86_400);
    expect(toSeconds("1w")).toBe(604_800);
    expect(toSeconds(42)).toBe(42);
    expect(toSeconds("42")).toBe(42);
  });
  it("rejects nonsense with friendly messages", () => {
    expect(() => toSeconds("2 fortnights")).toThrow(/unknown unit/);
    expect(() => toSeconds("0.5s")).toThrow(/whole number of seconds/);
    expect(() => toSeconds(-1)).toThrow(ProgError);
    expect(() => toSeconds("soon")).toThrow(/not a duration/);
  });
  it("format / parse round trip, and plain English", () => {
    const rng = new Rng(5);
    for (let i = 0; i < 2_000; i++) {
      const s = rng.range(0, 10_000_000);
      expect(toSeconds(formatDuration(s))).toBe(s);
    }
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(93_600)).toBe("1d2h");
    expect(formatDurationLong(5_401)).toBe("1 hour 30 minutes 1 second");
  });
});

describe("amounts", () => {
  it("SOL <-> lamports is exact (9 decimals max)", () => {
    expect(toLamports(0.5)).toBe(500_000_000n);
    expect(toLamports("1.000000001")).toBe(1_000_000_001n);
    expect(toLamports(1e-9)).toBe(1n);
    expect(toLamports(7n)).toBe(7n);
    expect(() => toLamports("0.0000000001")).toThrow(/at most 9/);
    expect(() => toLamports(-1)).toThrow(/negative/);
    expect(formatSol(1_500_000_000n)).toBe("1.5");
    expect(formatSol(123_456_789_000_000_000n, true)).toBe("123,456,789");
  });
  it("tokens <-> raw units with the token's decimals", () => {
    expect(toTokenUnits(1_000, 6)).toBe(1_000_000_000n);
    expect(toTokenUnits("0.000001", 6)).toBe(1n);
    expect(() => toTokenUnits("0.0000001", 6)).toThrow(ProgError);
    expect(formatTokens(1_234_567n, 6)).toBe("1.234567");
    expect(toTokenUnits(formatTokens(987_654_321_123n, 9), 9)).toBe(987_654_321_123n);
  });
  it("percent <-> bps in 0.01% steps", () => {
    expect(toBps("0.5%")).toBe(50);
    expect(toBps("25bps")).toBe(25);
    expect(toBps({ bps: 7 })).toBe(7);
    expect(() => toBps("0.001%")).toThrow(/0.01%/);
    for (let b = 1; b <= 10_000; b++) expect(toBps(formatBps(b) as `${number}%`)).toBe(b);
  });
  it("parseDecimal handles exponents and underscores exactly", () => {
    expect(parseDecimal("1e-7")).toEqual({ num: 1n, scale: 7 });
    expect(parseDecimal("1_000.50")).toEqual({ num: 10_005n, scale: 1 });
    expect(parseDecimal("2.5e3")).toEqual({ num: 2_500n, scale: 0 });
    expect(parseDecimal("abc")).toBeNull();
  });
});

describe("prices and dates", () => {
  it("isqrt is the exact floor square root", () => {
    const rng = new Rng(9);
    for (let i = 0; i < 2_000; i++) {
      const n = rng.next() * rng.next();
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
  it("price -> sqrt Q64 -> shortest price text -> the same sqrt Q64", () => {
    const rng = new Rng(11);
    for (let i = 0; i < 1_500; i++) {
      const dec = rng.pick([6, 9]);
      const s = rng.next() >> BigInt(rng.range(0, 50));
      const text = sqrtPriceQ64ToPriceText(s, dec);
      expect(priceToSqrtPriceQ64(text, dec)).toBe(s);
    }
    // 1e-6 SOL per token at 6 decimals: raw price 1e-3, sqrt = 0.0316..., * 2^64
    const s = priceToSqrtPriceQ64(0.000001, 6);
    expect(Number(s) / 2 ** 64).toBeCloseTo(Math.sqrt(0.001), 12);
    expect(sqrtPriceQ64ToPrice(s, 6)).toBeCloseTo(0.000001, 15);
    expect(() => priceToSqrtPriceQ64(10, 6)).toThrow(/too high/);
  });
  it("dates: ISO, date-only and unix; midnight prints as a date", () => {
    expect(toUnix("2027-01-01")).toBe(1_798_761_600n);
    expect(toUnix("2027-01-01T12:00:00Z")).toBe(1_798_804_800n);
    expect(toUnix(new Date(Date.UTC(2027, 0, 1)))).toBe(1_798_761_600n);
    expect(formatDate(1_798_761_600n)).toBe("2027-01-01");
    expect(formatDate(1_798_804_801n)).toBe("2027-01-01T12:00:01Z");
    expect(() => toUnix("next tuesday")).toThrow(ProgError);
  });
  it("base58 round trip (including leading zeros)", () => {
    const rng = new Rng(13);
    for (let i = 0; i < 500; i++) {
      const b = rng.bytes(32);
      if (i % 7 === 0) b.fill(0, 0, rng.range(1, 5));
      expect(decodeBase58(encodeBase58(b))).toEqual(b);
    }
    expect(encodeBase58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
});

describe("hashes", () => {
  const rulesBytes = rules({ guardSecs: 600 }).deny(when.buy(), "BOT").compile();
  const graphBytes = graph().node("b", every("1d"), null, burn(1)).compile();
  it("rulesHash = SHA256('PHX-RULES-V1' || bytes); none => 32 zero bytes", () => {
    expect(toHex(rulesHash(rulesBytes))).toBe(sha(PXR1.HASH_TAG, rulesBytes));
    expect(rulesHashHex(rulesBytes)).toBe(sha("PHX-RULES-V1", rulesBytes));
    expect(rulesHash(null)).toEqual(ZERO_HASH);
    expect(rulesHash(new Uint8Array(0))).toEqual(new Uint8Array(32));
  });
  it("graphHash = SHA256('PHX-GRAPH-V1' || bytes)", () => {
    expect(toHex(graphHash(graphBytes))).toBe(sha(PXG1.HASH_TAG, graphBytes));
  });
  it("hashes are content addresses: one changed byte, a different hash", () => {
    const b = rulesBytes.slice();
    b[b.length - 1]! ^= 1;
    expect(toHex(rulesHash(b))).not.toBe(toHex(rulesHash(rulesBytes)));
  });
});

describe("golden byte layouts (spec §1.2 / §1.3, little-endian)", () => {
  it("PXR1: 'first 2m: deny when buy code BOT' is 42 bytes, field by field", () => {
    const b = compileRules(rules({ guardSecs: 3_600 }).deny(when.buy(), { code: "BOT", first: "2m" }).build());
    expect(toHex(b)).toBe(
      [
        "50585231", // "PXR1"
        "01", // version
        "00", // n_keys
        "01", // n_rules
        "01", // n_nodes
        "00000000", // reserved
        "00000000", // from_rel 0
        "78000000", // to_rel 120
        "00", // cond_off
        "01", // cond_len
        "01", // effect DENY
        "01", // code BOT
        "0000000000000000", // arg
        "10", // IS_BUY
        "00", // a
        "0000000000000000", // arg
      ].join(""),
    );
  });

  it("PXR1: a bps cap sets bit 63 of the arg", () => {
    const b = compileRules(rules({ guardSecs: 600 }).capBalance("1%", when.always()).build());
    // rule arg is bytes 24..32: 100 bps | 1 << 63
    expect(toHex(b.slice(24, 32))).toBe("6400000000000080");
  });

  it("PXG1: a one-node graph is 102 bytes, field by field", () => {
    const b = compileGraph(graph().node("b", every("10m"), when.graduated(), burn(1), { epoch: "1h", budgetPerEpoch: 5, maxRunsPerEpoch: 6 }).build());
    expect(b.length).toBe(12 + 32 + 48 + 10);
    expect(toHex(b)).toBe(
      [
        "50584731", // "PXG1"
        "01", // version
        "00", // n_recipients
        "01", // n_nodes_g
        "01", // n_cond
        "00", // flags
        "000000", // reserved
        "00".repeat(32), // operator
        "01", // trigger EVERY
        "5802000000000000", // trigger_arg 600
        "00", // cond_off
        "01", // cond_len
        "02", // action BURN
        "00", // operator_gated
        "100e0000", // epoch_secs 3600
        "404b4c0000000000", // budget 5 tokens = 5,000,000
        "40420f0000000000", // p1 1 token = 1,000,000
        "0000000000000000", // p2
        "0600", // max_runs 6
        "0000000000", // reserved
        "22", // GRADUATED
        "00",
        "0000000000000000",
      ].join(""),
    );
  });
});

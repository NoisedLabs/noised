/**
 * Byte and behaviour parity with crates/noised-rules: runs the crate's own
 * vectors (tests/vectors/{rules,graph}.json, copied to test/vectors/programmable) through the
 * SDK. Every valid program must verify with the same hash, re-encode to the
 * same bytes and evaluate to the same results; every invalid one must fail
 * with exactly the named error, at the same stage (layout or semantics).
 * The seeded differential run (differential.json) is differential.test.ts.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import {
  ProgError,
  compileGraph,
  compileRules,
  currentEpochRaw,
  decodeGraphRaw,
  decodeRulesRaw,
  decompileGraph,
  decompileRules,
  encodeBase58,
  encodeGraphRaw,
  encodeRulesRaw,
  evaluateRuleSet,
  exceeds,
  fromHex,
  graphCondition,
  graphDue,
  graphHashHex,
  graphRunCap,
  graphRunnable,
  graphRunsInEpoch,
  graphShares,
  ruleCondition,
  rulesHashHex,
  threshold,
  toHex,
  verifyGraph,
  verifyGraphBytes,
  verifyRules,
  verifyRulesBytes,
} from "../../src/programmable/index.js";
import type { RawGraphCtx, RawNodeState, RuleEvalCtx, VerifyErrorCode } from "../../src/programmable/index.js";
import { LOCAL_VECTORS_DIR, VECTOR_FILES, VECTOR_SHA256, loadVectors, readVectorText } from "./vectorFiles.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

/** The crate's layout checks (RuleSet::parse / Graph::parse): the first stage of verify. */
const PXR1_PARSE_ERRORS: readonly string[] = [
  "TooShort", "BadMagic", "BadVersion", "ReservedNonZero", "TooManyKeys", "NoRules", "TooManyRules", "TooManyNodes", "BadLength",
] satisfies readonly VerifyErrorCode[];
const PXG1_PARSE_ERRORS: readonly string[] = [
  "TooShort", "BadMagic", "BadVersion", "UnknownFlags", "ReservedNonZero", "TooManyRecipients", "NoGraphNodes", "TooManyGraphNodes",
  "TooManyNodes", "BadLength",
] satisfies readonly VerifyErrorCode[];
/** The ProgError code `f` throws, or "ok". */
const codeOf = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof ProgError) return e.code;
    throw e;
  }
};
const b = (s: string): bigint => BigInt(s);
const key = (hex: string): string => encodeBase58(fromHex(hex));

function rulesCtx(c: J): RuleEvalCtx {
  return {
    nowRel: b(c.now_rel),
    isBuy: c.is_buy,
    isP2p: c.is_p2p,
    amount: b(c.amount),
    destBalanceAfter: b(c.dest_balance_after),
    supply: b(c.supply),
    destOwner: key(c.dest_owner),
    srcOwner: key(c.src_owner),
    topProgram: key(c.top_program),
    txIxCount: c.tx_ix_count,
  };
}
function graphCtx(c: J): RawGraphCtx {
  return {
    now: b(c.now),
    treasurySol: b(c.treasury_sol),
    treasuryToken: b(c.treasury_token),
    graduated: c.graduated,
    sqrtPrice: b(c.sqrt_price),
    runsInEpoch: c.runs_in_epoch,
  };
}
function state(s: J): RawNodeState {
  return { lastRun: b(s.last_run), lastSeq: b(s.last_seq), epochStart: b(s.epoch_start), runsInEpoch: s.runs_in_epoch, spentInEpoch: b(s.spent_in_epoch) };
}

describe("the SDK's vector copies", () => {
  it.each(VECTOR_FILES.map((f) => [f]))("%s is the copy of the crate's file pinned at the merge", (f) => {
    // When crates/noised-rules/tests/vectors changes: copy the file to test/vectors/programmable and update the pin.
    const hex = toHex(sha256(new TextEncoder().encode(readVectorText(LOCAL_VECTORS_DIR, f))));
    expect(hex, `update VECTOR_SHA256["${f}"] after copying the crate's file`).toBe(VECTOR_SHA256[f]);
  });
});

describe("crate vectors: PXR1", () => {
  const v = loadVectors("rules.json");

  it("has vectors", () => {
    expect(v.valid.length).toBeGreaterThan(10);
    expect(v.invalid.length).toBeGreaterThan(10);
  });

  it.each<[string, J]>(v.valid.map((x: J): [string, J] => [x.name, x]))("valid: %s", (_n, x: J) => {
    const bytes = fromHex(x.hex);
    expect(bytes.length).toBe(x.len);
    const r = verifyRules(bytes, { guardSecs: x.guard_secs });
    expect(r).toMatchObject({ ok: true });
    expect(rulesHashHex(bytes)).toBe(x.hash);
    const raw = verifyRulesBytes(bytes, { guardSecs: x.guard_secs });
    expect(toHex(encodeRulesRaw(decodeRulesRaw(bytes)))).toBe(x.hex);
    for (const c of x.cases) {
      const ctx = rulesCtx(c.ctx);
      const got = evaluateRuleSet(raw, ctx);
      expect(got).toEqual(c.violation === null ? { ok: true } : { ok: false, index: c.violation.rule, code: c.violation.code });
      expect(raw.rules.map((_, i) => ruleCondition(raw, i, ctx))).toEqual(c.conditions);
    }
    // the model round trip is exact whenever the model can represent the values
    try {
      const model = decompileRules(bytes, { guardSecs: Math.min(x.guard_secs, 259_200) });
      expect(toHex(compileRules(model))).toBe(x.hex);
    } catch (e) {
      expect(e).toBeInstanceOf(ProgError);
      expect((e as ProgError).code).toBe("BadModel");
    }
  });

  it.each<[string, J]>(v.invalid.map((x: J): [string, J] => [x.name, x]))("invalid: %s", (_n, x: J) => {
    const bytes = fromHex(x.hex);
    const r = verifyRules(bytes, { guardSecs: x.guard_secs });
    expect(r.ok ? "ok" : r.code).toBe(x.error);
    // verify parses first: a layout error is the parser's, anything else passes the parser
    const parsed = codeOf(() => decodeRulesRaw(bytes));
    expect(parsed).toBe(PXR1_PARSE_ERRORS.includes(x.error) ? x.error : "ok");
    if (parsed === "ok") expect(toHex(encodeRulesRaw(decodeRulesRaw(bytes)))).toBe(x.hex);
  });

  it("thresholds: exceeds() and threshold() match", () => {
    for (const t of v.thresholds) {
      expect(exceeds(b(t.value), b(t.arg), b(t.supply))).toBe(t.exceeds);
      expect(threshold(b(t.arg), b(t.supply))).toBe(b(t.threshold));
    }
  });
});

describe("crate vectors: PXG1", () => {
  const v = loadVectors("graph.json");

  it("has vectors", () => {
    expect(v.valid.length).toBeGreaterThan(10);
    expect(v.invalid.length).toBeGreaterThan(10);
  });

  it.each<[string, J]>(v.valid.map((x: J): [string, J] => [x.name, x]))("valid: %s", (_n, x: J) => {
    const bytes = fromHex(x.hex);
    expect(bytes.length).toBe(x.len);
    expect(verifyGraph(bytes)).toMatchObject({ ok: true });
    expect(graphHashHex(bytes)).toBe(x.hash);
    const raw = verifyGraphBytes(bytes);
    expect(toHex(encodeGraphRaw(decodeGraphRaw(bytes)))).toBe(x.hex);
    for (const c of x.conditions) {
      const ctx = graphCtx(c.ctx);
      expect(raw.nodes.map((_, i) => graphCondition(raw, i, ctx))).toEqual(c.holds);
    }
    for (const s of x.schedule) {
      const ctx = graphCtx(s.ctx);
      const states = s.states.map(state);
      // the crate built ctx.runs_in_epoch with Graph::runs_in_epoch(states, now)
      expect(graphRunsInEpoch(raw, states, ctx.now)).toEqual(s.ctx.runs_in_epoch);
      expect(raw.nodes.map((_, i) => graphDue(raw, i, states, ctx.now, ctx.graduated) ?? "Due")).toEqual(s.due);
      expect(raw.nodes.map((_, i) => graphRunnable(raw, i, states, ctx) ?? "Due")).toEqual(s.runnable);
      expect(raw.nodes.map((_, i) => graphRunCap(raw, i, states[i]!, ctx.now).toString())).toEqual(s.run_cap);
    }
    for (const sh of x.shares) {
      expect(graphShares(raw, b(sh.amount)).slice(0, raw.recipients.length).map(String)).toEqual(sh.shares);
    }
    try {
      expect(toHex(compileGraph(decompileGraph(bytes)))).toBe(x.hex);
    } catch (e) {
      expect(e).toBeInstanceOf(ProgError);
      expect((e as ProgError).code).toBe("BadModel");
    }
  });

  it.each<[string, J]>(v.invalid.map((x: J): [string, J] => [x.name, x]))("invalid: %s", (_n, x: J) => {
    const bytes = fromHex(x.hex);
    const r = verifyGraph(bytes);
    expect(r.ok ? "ok" : r.code).toBe(x.error);
    const parsed = codeOf(() => decodeGraphRaw(bytes));
    // ReservedNonZero is the parser's for the header bytes 9..12, the verifier's for a node's
    const layout = x.error === "ReservedNonZero" ? bytes.subarray(9, 12).some((y) => y !== 0) : PXG1_PARSE_ERRORS.includes(x.error);
    expect(parsed).toBe(layout ? x.error : "ok");
    if (parsed === "ok") expect(toHex(encodeGraphRaw(decodeGraphRaw(bytes)))).toBe(x.hex);
  });

  it("epochs: currentEpochRaw matches current_epoch", () => {
    for (const e of v.epochs) {
      const got = currentEpochRaw(e.epoch_secs, state(e.state), b(e.now));
      expect({ start: got.start.toString(), runs: got.runs, spent: got.spent.toString() }).toEqual(e.epoch);
    }
  });
});

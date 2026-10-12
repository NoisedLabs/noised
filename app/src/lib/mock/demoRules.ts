/**
 * The demo's creator rules (MOCK only): which seeded launches have launch rules and what they are. One source for the
 * chain seed (fixtures.ts: the attestation binds the rules' hash, so the certificate records it and carries
 * RULES_BOUND, checks = 8,191, exactly like a real launch with rules) and the programmable seed (programmable.ts: the
 * published record the hook enforces).
 */
import { compileRules, rulesHash, type RuleSet } from "@noisedlabs/sdk/programmable";

import { demoKey } from "./keys";

const MERIDIAN_DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** The rule set a seeded launch's creator signed, or null when it has none. */
export function demoRuleSet(symbol: string, l: { openDelaySecs: number; guardSecs: number; tokenDecimal: number }): RuleSet | null {
  if (symbol === "AEGS") {
    // Anti-bot rules for the first 15 minutes of trading and small buys at first.
    const t = l.openDelaySecs + 600;
    return {
      guardSecs: l.guardSecs,
      tokenDecimals: l.tokenDecimal,
      keys: [
        { address: MERIDIAN_DBC, label: "meteora" },
        { address: JUPITER, label: "jupiter" },
      ],
      rules: [
        { from: 0, to: t + 15 * 60, effect: "deny", when: { op: "and", a: { op: "buy" }, b: { op: "ixCountGt", n: 12 } }, code: 1 },
        {
          from: 0,
          to: t + 15 * 60,
          effect: "deny",
          when: { op: "and", a: { op: "buy" }, b: { op: "not", x: { op: "programIn", keys: [MERIDIAN_DBC, JUPITER] } } },
          code: 9,
        },
        { from: 0, to: t + 30 * 60, effect: "capAmount", cap: { bps: 25 }, when: { op: "buy" }, code: 8 },
      ],
    };
  }
  if (symbol === "LNTN") {
    // A whale cap for its (now finished) guard, and an early allowlist: for its first minutes of trading only two
    // wallets its creator chose could buy. The demo's example of what QSL-1 warns holders about (insider-only buying).
    const early = [demoKey("early-buyer/LNTN/1").toBase58(), demoKey("early-buyer/LNTN/2").toBase58()];
    return {
      guardSecs: l.guardSecs,
      tokenDecimals: l.tokenDecimal,
      keys: early.map((address, i) => ({ address, label: `early-${i + 1}` })),
      rules: [
        { from: 0, to: null, effect: "capBalance", cap: { bps: 100 }, when: { op: "true" }, code: 3 },
        { from: 0, to: l.openDelaySecs + 600 + 20 * 60, effect: "deny", when: { op: "and", a: { op: "buy" }, b: { op: "not", x: { op: "toIn", keys: early } } }, code: 5 },
      ],
    };
  }
  return null;
}

/** The hash a seeded launch's attestation binds (all zero: no rules). */
export function demoRulesHash(symbol: string, l: { openDelaySecs: number; guardSecs: number; tokenDecimal: number }): Uint8Array {
  const set = demoRuleSet(symbol, l);
  return set === null ? new Uint8Array(32) : rulesHash(compileRules(set));
}

/** Rule codes: 0..=63, shown to the holder whose transfer a rule refuses. */
import { RULE_CODE_TEXT, RULE_CODES, type RuleCodeName } from "../constants.js";
import { ProgError } from "../errors.js";

/** A rule code: 0..=63 or a name from RULE_CODES ("BOT", "WHALE", ...). */
export type RuleCodeLike = number | RuleCodeName;

/** Resolves a code name or number; throws for anything outside 0..=63. */
export function ruleCode(c: RuleCodeLike | undefined): number {
  if (c === undefined) return 0;
  if (typeof c === "number") {
    if (!Number.isInteger(c) || c < 0 || c > 63) throw new ProgError("BadCode", `rule code ${c} must be 0..=63`);
    return c;
  }
  const v = (RULE_CODES as Record<string, number>)[String(c).toUpperCase()];
  if (v === undefined) throw new ProgError("BadCode", `unknown rule code "${c}" (use ${Object.keys(RULE_CODES).join(", ")} or 0..63)`);
  return v;
}

/** Plain-English text of a rule code ("Looks like a bot transaction"), or null for unnamed codes. */
export function ruleCodeText(code: number): string | null {
  return RULE_CODE_TEXT[code] ?? null;
}

/** The DSL name of a rule code ("BOT"), or null. */
export function ruleCodeName(code: number): string | null {
  for (const [k, v] of Object.entries(RULE_CODES)) if (v === code) return k;
  return null;
}

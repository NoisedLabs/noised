/**
 * Program errors the bundled SDK's IDLs do not name yet, so a failure that
 * carries one is still explained in plain words (and the simulated chain
 * can raise it by name). Each entry mirrors the program's own definition:
 * remove it once the SDK's IDL carries it (`explainProgramError` then wins,
 * and test/live-backend.test.ts says so).
 *
 *   - Launch Guard 6010 `MutableOwner` (audit round 3, F2): while the guard
 *     is on, a transfer that is not a sell is refused when the receiving
 *     token account lacks Token-2022's ImmutableOwner extension (its owner
 *     could be reassigned, which would undo the wallet-to-wallet pause and
 *     the max-wallet cap). Associated token accounts of Token-2022 always
 *     have it.
 *   - Launch Guard 6011 `RuleDenied` (PROGRAMMABLE_V1 §1.2): a custom launch
 *     rule refused the transfer (the hook logs the rule's index and code).
 *     Raised by the simulated chain only until the hook ships custom rules.
 */
import { explainProgramError, PROGRAM_IDS } from "@noisedlabs/sdk";

export interface AppProgramError {
  program: "hook";
  code: number;
  name: string;
  message: string;
}

/** The Launch Guard's refusal of a receiving account without an immutable owner (HookError 6010). */
export const MUTABLE_OWNER: AppProgramError = {
  program: "hook",
  code: 6010,
  name: "MutableOwner",
  message: "Launch guard: the receiving token account must have an immutable owner while the guard is on",
};

/** A custom launch rule refused the transfer (HookError 6011, appended after 6010). */
export const RULE_DENIED: AppProgramError = {
  program: "hook",
  code: 6011,
  name: "RuleDenied",
  message: "Launch rule: this transfer is not allowed right now",
};

export const APP_PROGRAM_ERRORS: readonly AppProgramError[] = [MUTABLE_OWNER, RULE_DENIED];

const PROGRAM_OF = { hook: PROGRAM_IDS.hook } as const;
const LABEL_OF = { hook: "noised_hook" } as const;

/** The SDK's explanation of a program error, else this table's, else null. */
export function explainAnyProgramError(programId: string, code: number): { program: string; name: string; message: string } | null {
  const known = explainProgramError(programId, code);
  if (known !== null) return known;
  const extra = APP_PROGRAM_ERRORS.find((e) => e.code === code && PROGRAM_OF[e.program].toBase58() === programId);
  return extra === undefined ? null : { program: LABEL_OF[extra.program], name: extra.name, message: extra.message };
}

/** The code of a named error of this table (the simulated chain raises it like an IDL error), or null. */
export function appErrorCode(program: string, name: string): number | null {
  return APP_PROGRAM_ERRORS.find((e) => e.program === program && e.name === name)?.code ?? null;
}

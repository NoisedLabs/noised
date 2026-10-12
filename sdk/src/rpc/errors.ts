/**
 * Program error codes -> human messages, from the IDLs (our five programs,
 * Meteora DBC and DAMM v2), Anchor's framework errors and SPL Token's errors.
 */
import type { PublicKey } from "@solana/web3.js";

import { HOOK_ERRORS, KNOWN_ACCOUNTS, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";

/** Names of the programs this SDK expects in its transactions. */
export const KNOWN_PROGRAMS: ReadonlyMap<string, string> = new Map([
  [PROGRAM_IDS.launchpad.toBase58(), "noised_launchpad"],
  [PROGRAM_IDS.hook.toBase58(), "noised_hook"],
  [PROGRAM_IDS.vault.toBase58(), "noised_vault"],
  [PROGRAM_IDS.shield.toBase58(), "noised_shield"],
  [PROGRAM_IDS.autopilot.toBase58(), "noised_autopilot"],
  [PROGRAM_IDS.dbc.toBase58(), "meteora_dbc"],
  [PROGRAM_IDS.dammV2.toBase58(), "meteora_damm_v2"],
  [KNOWN_ACCOUNTS.token2022.toBase58(), "spl_token_2022"],
  [KNOWN_ACCOUNTS.splToken.toBase58(), "spl_token"],
  [KNOWN_ACCOUNTS.associatedToken.toBase58(), "spl_associated_token_account"],
  [KNOWN_ACCOUNTS.system.toBase58(), "system_program"],
  [KNOWN_ACCOUNTS.computeBudget.toBase58(), "compute_budget"],
]);

export function programLabel(programId: PublicKey | string): string | null {
  return KNOWN_PROGRAMS.get(typeof programId === "string" ? programId : programId.toBase58()) ?? null;
}

/** Anchor framework errors that builders can trigger (anchor-lang-error 1.2.1 `ErrorCode`, verified). */
const ANCHOR_ERRORS: Readonly<Record<number, [string, string]>> = {
  100: ["InstructionMissing", "Instruction discriminator not provided"],
  101: ["InstructionFallbackNotFound", "Unknown instruction for this program"],
  102: ["InstructionDidNotDeserialize", "Instruction data could not be deserialized"],
  2000: ["ConstraintMut", "An account that must be writable is not"],
  2001: ["ConstraintHasOne", "An account does not belong to the expected parent (has_one)"],
  2002: ["ConstraintSigner", "A required signature is missing"],
  2003: ["ConstraintRaw", "An account constraint was violated"],
  2004: ["ConstraintOwner", "An account has the wrong owner"],
  2006: ["ConstraintSeeds", "An account is not the expected program address (seeds)"],
  2009: ["ConstraintAssociated", "A token account is not the canonical associated token account"],
  2010: ["ConstraintAssociatedInit", "The associated token account could not be created"],
  2012: ["ConstraintAddress", "An account does not have the required address"],
  2014: ["ConstraintTokenMint", "A token account has the wrong mint"],
  2015: ["ConstraintTokenOwner", "A token account has the wrong owner"],
  2020: ["ConstraintAccountIsNone", "A required optional account was not passed"],
  2021: ["ConstraintTokenTokenProgram", "A token account belongs to the wrong token program"],
  2022: ["ConstraintMintTokenProgram", "A mint belongs to the wrong token program"],
  2023: ["ConstraintAssociatedTokenTokenProgram", "An associated token account belongs to the wrong token program"],
  2040: ["ConstraintDuplicateMutableAccount", "The same writable account was passed twice"],
  2500: ["RequireViolated", "A program requirement was violated"],
  2502: ["RequireKeysEqViolated", "An account key does not match"],
  3001: ["AccountDiscriminatorNotFound", "An account has no data where a program account was expected"],
  3002: ["AccountDiscriminatorMismatch", "An account is of the wrong type"],
  3003: ["AccountDidNotDeserialize", "An account could not be decoded"],
  3005: ["AccountNotEnoughKeys", "Not enough accounts were passed"],
  3007: ["AccountOwnedByWrongProgram", "An account is owned by the wrong program"],
  3008: ["InvalidProgramId", "A program account is not the expected program"],
  3009: ["InvalidProgramExecutable", "A program account is not executable"],
  3010: ["AccountNotSigner", "An account must sign this transaction"],
  3012: ["AccountNotInitialized", "An account that must exist does not exist yet"],
  3014: ["AccountNotAssociatedTokenAccount", "Not the canonical associated token account"],
};

/** SPL Token / Token-2022 `TokenError` (first variants). */
const TOKEN_ERRORS: readonly [string, string][] = [
  ["NotRentExempt", "Account is not rent-exempt"],
  ["InsufficientFunds", "Insufficient token balance"],
  ["InvalidMint", "Invalid mint"],
  ["MintMismatch", "Token account does not match the mint"],
  ["OwnerMismatch", "Token account owner does not match"],
  ["FixedSupply", "This token's supply is fixed"],
  ["AlreadyInUse", "Account already in use"],
  ["InvalidNumberOfProvidedSigners", "Invalid number of provided signers"],
  ["InvalidNumberOfRequiredSigners", "Invalid number of required signers"],
  ["UninitializedState", "Token state is uninitialized"],
  ["NativeNotSupported", "Instruction does not support native tokens"],
  ["NonNativeHasBalance", "Non-native account can only be closed with a zero balance"],
  ["InvalidInstruction", "Invalid token instruction"],
  ["InvalidState", "Token account is in an invalid state"],
  ["Overflow", "Arithmetic overflow"],
  ["AuthorityTypeNotSupported", "Authority type not supported"],
  ["MintCannotFreeze", "This token mint cannot freeze accounts"],
  ["AccountFrozen", "The token account is frozen"],
  ["MintDecimalsMismatch", "Mint decimals mismatch"],
  ["NonNativeNotSupported", "Instruction does not support non-native tokens"],
];

/**
 * Hook errors a hook IDL older than the program may lack (audit round 3 F2
 * appends `MutableOwner`); the IDL's own entry wins once it has one.
 */
const HOOK_APPENDED_ERRORS: Readonly<Record<number, [string, string]>> = {
  [HOOK_ERRORS.MutableOwner]: ["MutableOwner", "Launch guard: the receiving token account must have an immutable owner while the guard is on"],
};

/**
 * Plain-English messages for errors a person meets in an app, keyed by
 * program and code (the IDL's message stays the technical one). P1c: the
 * hook's launch-rule errors and the launchpad's `InvalidRules`; review 4,
 * R5: the autopilot's `FreezeExpired` (6040); audit round 4: the
 * autopilot's `RemainderTooSmall` (6041) and `NoRecipientAccount` (6042).
 */
export const PLAIN_ERROR_MESSAGES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  [PROGRAM_IDS.hook.toBase58()]: {
    [HOOK_ERRORS.RuleDenied]: "A launch rule set by the creator blocks this transfer right now. Launch rules only apply during the launch's first hours and never block selling.",
    [HOOK_ERRORS.InvalidRules]: "The launch rules are not valid for this launch, so the launch cannot go ahead.",
  },
  [PROGRAM_IDS.launchpad.toBase58()]: {
    6048: "These launch rules are not valid for this launch: they must be well-formed and end before the launch's protection period does.",
  },
  [PROGRAM_IDS.autopilot.toBase58()]: {
    6040: "This freeze approval has expired (it was signed to be used only until a set time). Sign a new freeze.",
    6041: "This smaller buyback would leave too little of the step's amount to buy back later. Buy back the whole amount, or leave at least 1% of the pool's SOL for the rest.",
    6042: "Nobody can be paid right now: none of this step's recipients has a wrapped SOL (wSOL) account yet. Their share stays in the treasury until one of them creates one.",
  },
};

/** The plain-English message of a program error, when the SDK has one (else null: use `explainProgramError`'s message). */
export function plainErrorMessage(programId: PublicKey | string, code: number): string | null {
  const id = typeof programId === "string" ? programId : programId.toBase58();
  return PLAIN_ERROR_MESSAGES[id]?.[code] ?? null;
}

const IDL_BY_PROGRAM = (): ReadonlyMap<string, keyof ReturnType<typeof idlCodecs>> =>
  new Map([
    [PROGRAM_IDS.launchpad.toBase58(), "launchpad"],
    [PROGRAM_IDS.hook.toBase58(), "hook"],
    [PROGRAM_IDS.vault.toBase58(), "vault"],
    [PROGRAM_IDS.shield.toBase58(), "shield"],
    [PROGRAM_IDS.autopilot.toBase58(), "autopilot"],
    [PROGRAM_IDS.dbc.toBase58(), "dbc"],
    [PROGRAM_IDS.dammV2.toBase58(), "dammV2"],
  ]);

/**
 * Name and message of a custom error code raised by `programId`, if known;
 * `plain` (only when the SDK has one, `PLAIN_ERROR_MESSAGES`) is the
 * sentence to show a person.
 */
export function explainProgramError(programId: string, code: number): { program: string; name: string; message: string; plain?: string } | null {
  const program = KNOWN_PROGRAMS.get(programId) ?? programId;
  const idlKey = IDL_BY_PROGRAM().get(programId);
  if (idlKey !== undefined) {
    const e = idlCodecs()[idlKey].errorByCode(code);
    const plain = plainErrorMessage(programId, code);
    if (e !== null) return { program, name: e.name, message: e.msg ?? e.name, ...(plain === null ? {} : { plain }) };
    const appended = idlKey === "hook" ? HOOK_APPENDED_ERRORS[code] : undefined;
    if (appended !== undefined) return { program, name: appended[0], message: appended[1] };
    const a = ANCHOR_ERRORS[code];
    if (a !== undefined) return { program, name: a[0], message: a[1] };
    return null;
  }
  if (programId === KNOWN_ACCOUNTS.splToken.toBase58() || programId === KNOWN_ACCOUNTS.token2022.toBase58()) {
    const t = TOKEN_ERRORS[code];
    if (t !== undefined) return { program, name: t[0], message: t[1] };
  }
  return null;
}

/**
 * The innermost failing program and its custom error code, from runtime logs
 * (`Program <id> failed: custom program error: 0x<code>`; the innermost
 * failure is logged first, then every caller repeats it).
 */
export function failedProgramFromLogs(logs: readonly string[]): { programId: string; code: number | null; line: string } | null {
  for (const line of logs) {
    const m = /^Program (\w+) failed: (.*)$/.exec(line);
    if (m === null) continue;
    const custom = /custom program error: 0x([0-9a-fA-F]+)/.exec(m[2]!);
    return { programId: m[1]!, code: custom === null ? null : parseInt(custom[1]!, 16), line };
  }
  return null;
}

/**
 * The custom program error code a failed send or confirmation carries, or
 * null: from the error's `logs` (a preflight failure), its message (a
 * confirmation's `{"Custom":<code>}` or the runtime's `custom program error:
 * 0x<code>`), or its `cause`. Anchor framework errors (2006
 * ConstraintSeeds, 3012 AccountNotInitialized) are custom codes too.
 */
export function customErrorCode(e: unknown): number | null {
  for (let x: unknown = e, depth = 0; x !== null && x !== undefined && depth < 4; depth++) {
    if (typeof x === "object") {
      const logs = (x as { logs?: unknown }).logs;
      if (Array.isArray(logs) && logs.every((l) => typeof l === "string")) {
        const failed = failedProgramFromLogs(logs as string[]);
        if (failed !== null && failed.code !== null) return failed.code;
      }
    }
    const message = x instanceof Error ? x.message : typeof x === "string" ? x : "";
    const json = /"Custom"\s*:\s*(\d+)/.exec(message);
    if (json !== null) return Number(json[1]);
    const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(message);
    if (hex !== null) return parseInt(hex[1]!, 16);
    x = x instanceof Error ? x.cause : undefined;
  }
  return null;
}

/** Turn a transaction error (+ logs) into `{error, errorCode}` for humans. */
export function explainTransactionError(
  err: unknown,
  logs: readonly string[],
): { error: string; errorCode: { program: string; code: number; name: string } | null } {
  const failed = failedProgramFromLogs(logs);
  let code: number | null = null;
  if (typeof err === "object" && err !== null && "InstructionError" in err) {
    const ie = (err as { InstructionError: [number, unknown] }).InstructionError;
    const detail = ie[1];
    if (typeof detail === "object" && detail !== null && "Custom" in detail) code = Number((detail as { Custom: number }).Custom);
    if (failed !== null && (failed.code === code || code === null)) {
      const known = failed.code === null ? null : explainProgramError(failed.programId, failed.code);
      if (known !== null && failed.code !== null) {
        return { error: `${known.program}: ${known.message} (${known.name}, ${failed.code})`, errorCode: { program: known.program, code: failed.code, name: known.name } };
      }
      const label = KNOWN_PROGRAMS.get(failed.programId) ?? failed.programId;
      return { error: `${label} failed: ${failed.line.replace(/^Program \w+ failed: /, "")}`, errorCode: null };
    }
    return { error: `Instruction ${ie[0]} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`, errorCode: null };
  }
  const anchorLine = logs.find((l) => l.includes("AnchorError"));
  if (anchorLine !== undefined) return { error: anchorLine.replace(/^Program log: /, ""), errorCode: null };
  return { error: typeof err === "string" ? err : JSON.stringify(err), errorCode: null };
}

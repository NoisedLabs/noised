/**
 * Errors of the programmable module.
 *
 * `VerifyErrorCode` is exactly the Rust crate's `noised_rules::Error`
 * (crates/noised-rules/src/lib.rs, same names, same check order), so a
 * PXR1 / PXG1 input is refused with the same name by the SDK and on-chain.
 */

/** noised_rules::Error, in discriminant order. */
export const VERIFY_ERRORS = [
  "TooShort",
  "BadMagic",
  "BadVersion",
  "ReservedNonZero",
  "BadLength",
  "TooManyNodes",
  "TooManyKeys",
  "NoRules",
  "TooManyRules",
  "ZeroKey",
  "DuplicateKey",
  "UnusedKey",
  "BadWindow",
  "WindowPastGuard",
  "BadCode",
  "UnknownEffect",
  "DenyArgNonZero",
  "ZeroCap",
  "BadBps",
  "EmptyCondition",
  "ConditionNotContiguous",
  "ConditionOutOfRange",
  "UnreferencedNode",
  "UnknownOp",
  "NonZeroOperand",
  "BadKeyMask",
  "TimeOutOfRange",
  "BadNodeRef",
  "StackUnderflow",
  "StackOverflow",
  "LeftoverValues",
  "UnknownFlags",
  "TooManyRecipients",
  "NoGraphNodes",
  "TooManyGraphNodes",
  "MissingOperator",
  "UnexpectedOperator",
  "ZeroRecipient",
  "DuplicateRecipient",
  "ZeroRecipientBps",
  "BadRecipientBps",
  "UnknownTrigger",
  "EveryTooShort",
  "BadAfterRef",
  "AfterCycle",
  "TriggerArgNonZero",
  "WhenWithoutCondition",
  "UnknownAction",
  "ReservedAction",
  "ZeroP1",
  "PremiumTooHigh",
  "P2NonZero",
  "NoRecipients",
  "BadOperatorGated",
  "GatedWithoutOperator",
  "EpochTooShort",
  "ZeroBudget",
  "ZeroMaxRuns",
  "OperatorUnused",
  "RecipientsUnused",
] as const;

/** A byte-format / verifier error (= noised_rules::Error). */
export type VerifyErrorCode = (typeof VERIFY_ERRORS)[number];

/** Errors raised while turning a model (builder / DSL / canvas output) into bytes. */
export type ModelErrorCode =
  | "WrongContext"
  | "UnknownKey"
  | "UnknownNode"
  | "DuplicateNode"
  | "BadAmount"
  | "BadDuration"
  | "BadAddress"
  | "PriceOutOfRange"
  | "BadModel";

export type ProgErrorCode = VerifyErrorCode | ModelErrorCode;

/** Where in a rule set / graph an error is. */
export interface ProgErrorAt {
  /** Rule index (PXR1). */
  rule?: number;
  /** Graph node index (PXG1). */
  node?: number;
  /** Condition node index (into the nodes / cond nodes array). */
  condNode?: number;
  /** Key or recipient index. */
  key?: number;
}

export class ProgError extends Error {
  override readonly name = "ProgError";
  constructor(
    readonly code: ProgErrorCode,
    message: string,
    readonly at: ProgErrorAt = {},
  ) {
    super(message);
  }
}

/** True for codes the verifiers return (as opposed to model / builder errors). */
export const isVerifyErrorCode = (c: string): c is VerifyErrorCode => (VERIFY_ERRORS as readonly string[]).includes(c);

/** A text-DSL error with a 1-based position, ready to underline in an editor. */
export class DslError extends Error {
  override readonly name = "DslError";
  constructor(
    message: string,
    /** 1-based line. */
    readonly line: number,
    /** 1-based column. */
    readonly col: number,
    /** 0-based offset into the source text. */
    readonly offset: number,
    /** Length of the offending text (>= 1). */
    readonly length: number,
    /** A short suggestion, e.g. "write it as 2m or 120s". */
    readonly hint?: string,
  ) {
    super(message);
  }

  /** "line 3, col 14: ..." */
  get pretty(): string {
    return `line ${this.line}, col ${this.col}: ${this.message}${this.hint ? ` (${this.hint})` : ""}`;
  }
}

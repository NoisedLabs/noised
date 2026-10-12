/**
 * Programmable launches (design/prog/PROGRAMMABLE_V1.md §1): byte formats,
 * opcodes and limits shared by launch rules (PXR1) and autopilot graphs (PXG1).
 *
 * Mirrors crates/noised-rules (same values). Simulation-only defaults that
 * the program decides are marked "simulation default".
 */

/** RPN condition VM (spec §1.1). */
export const VM = {
  /** One condition node: op u8 | a u8 | arg u64 (LE). */
  NODE_SIZE: 10,
  /** Maximum boolean stack depth. */
  MAX_STACK: 16,
} as const;

/** Every opcode of the condition VM. 0x10.. are rule leaves, 0x20.. graph leaves. */
export const OP = {
  TRUE: 0x00,
  FALSE: 0x01,
  AND: 0x02,
  OR: 0x03,
  NOT: 0x04,
  // ---- launch-rule leaves (context RULES) ----
  IS_BUY: 0x10,
  IS_P2P: 0x11,
  TIME_LT: 0x12,
  TIME_GE: 0x13,
  AMOUNT_GT: 0x14,
  DEST_BAL_AFTER_GT: 0x15,
  DEST_OWNER_IN: 0x16,
  SRC_OWNER_IN: 0x17,
  TOP_PROGRAM_IN: 0x18,
  TX_IX_COUNT_GT: 0x19,
  // ---- autopilot leaves (context GRAPH) ----
  TREASURY_SOL_GTE: 0x20,
  TREASURY_TOKEN_GTE: 0x21,
  GRADUATED: 0x22,
  PRICE_LTE: 0x23,
  PRICE_GTE: 0x24,
  NOW_GE: 0x25,
  NOW_LT: 0x26,
  RUNS_IN_EPOCH_LT: 0x27,
} as const;
export type OpCode = (typeof OP)[keyof typeof OP];

/** Launch rule set "PXR1" (spec §1.2). */
export const PXR1 = {
  MAGIC: "PXR1",
  VERSION: 1,
  HEADER_SIZE: 12,
  KEY_SIZE: 32,
  RULE_SIZE: 20,
  MAX_KEYS: 8,
  MAX_RULES: 16,
  MAX_NODES: 64,
  /** 12 + 8*32 + 16*20 + 64*10. */
  MAX_SIZE: 1_228,
  /** Rule codes are shown to users and must be < 64. */
  MAX_CODE: 63,
  /** rules_hash = SHA256(HASH_TAG || bytes); the all-zero hash means "no custom rules". */
  HASH_TAG: "PHX-RULES-V1",
  /** The hook's hard bound: every restriction ends at most 72 h after open. */
  MAX_GUARD_SECS: 72 * 60 * 60,
  /** Violation code of a malformed (unverified) rule set; verified sets never raise it. */
  CODE_MALFORMED: 0xff,
} as const;

/**
 * Launch timing the rule templates build on (the launchpad's constants; the
 * SDK's POLICY): rule times count from the launch's open, the start of the
 * fair-open batch window (`openDelaySecs`); buys from the pool are refused
 * until the batch has run, at most EXECUTION_GRACE_SECS after the window.
 */
export const LAUNCH_TIMING = {
  EXECUTION_GRACE_SECS: 600,
  MIN_OPEN_DELAY_SECS: 60,
  MAX_OPEN_DELAY_SECS: 1_800,
  /** The "fair" preset's batch window: the templates' default. */
  DEFAULT_OPEN_DELAY_SECS: 300,
} as const;

/** Rule effects (spec §1.2). */
export const EFFECT = {
  DENY: 1,
  CAP_AMOUNT: 2,
  CAP_DEST_BALANCE: 3,
} as const;

/** Amount argument flag: bit 63 set means (arg & 0xFFFF) bps of supply. */
export const BPS_FLAG = 1n << 63n;
export const BPS_DENOMINATOR = 10_000;

/** Autopilot graph "PXG1" (spec §1.3). */
export const PXG1 = {
  MAGIC: "PXG1",
  VERSION: 1,
  HEADER_SIZE: 12,
  OPERATOR_SIZE: 32,
  RECIPIENT_SIZE: 34,
  GNODE_SIZE: 48,
  MAX_RECIPIENTS: 8,
  MAX_NODES: 16,
  MAX_COND_NODES: 96,
  /** 12 + 32 + 8*34 + 16*48 + 96*10. */
  MAX_SIZE: 2_044,
  /** flags bit0: the graph names an operator. */
  FLAG_HAS_OPERATOR: 0x01,
  /** graph_hash = SHA256(HASH_TAG || bytes). */
  HASH_TAG: "PHX-GRAPH-V1",
  /** EVERY trigger: at least 10 minutes. */
  MIN_EVERY_SECS: 600,
  /** Budget epochs last at least an hour. */
  MIN_EPOCH_SECS: 3_600,
  /** A buyback may pay at most 20% over the reference price (keeper sandwich <= premium * p1). */
  MAX_PREMIUM_BPS: 2_000,
  /** NOW_GE / NOW_LT take a unix time <= i64::MAX. */
  MAX_UNIX: (1n << 63n) - 1n,
} as const;

/** GNode triggers (spec §1.3). */
export const TRIGGER = {
  EVERY: 1,
  AFTER: 2,
  ON_GRADUATED: 3,
  WHEN: 4,
} as const;

/** GNode actions (spec §1.3). 4 and 5 are reserved for P2. */
export const ACTION = {
  BUYBACK_BURN: 1,
  BURN: 2,
  DISTRIBUTE_SOL: 3,
  /** Reserved for a later version (verifier: ReservedAction). */
  ADD_LOCKED_LIQUIDITY: 4,
  /** Reserved for a later version (verifier: ReservedAction). */
  MERKLE_AIRDROP: 5,
} as const;

/**
 * Autopilot runtime constants: programs/noised-autopilot src/constants.rs
 * (pinned by test/programmable/autopilot.vectors.test.ts against values the
 * program printed).
 */
export const AUTOPILOT = {
  /** A replacement graph takes effect at least 72 h after both it was queued and its authorization landed. */
  UPDATE_TIMELOCK_SECS: 259_200,
  /** Paid to whoever runs a due node, in wSOL from the treasury (at most; see TIP_MAX_SHARE_BPS). */
  TIP_LAMPORTS: 100_000n,
  /** At most this much of the treasury goes to tips per tip epoch (50 tips). */
  TIP_EPOCH_CAP: 5_000_000n,
  /** Tips are counted per UTC day. */
  TIP_EPOCH_SECS: 86_400,
  /** A tip is at most this share (per 10,000) of what the run moved (burns valued at the reference price). */
  TIP_MAX_SHARE_BPS: 1_000,
  /** The reference price rises at most 5% per hour (it falls at once to what every observation agrees on). */
  REF_MAX_MOVE_BPS: 500,
  /** The reference's rise rate in sqrt-bps per hour (e^0.0243 < 1.0246, 1.0246^2 < 1.05). */
  REF_UP_SQRT_BPS_PER_HOUR: 243,
  /** One hour's worth of rise allowance (sqrt-bps-seconds). */
  REF_ALLOWANCE_MAX: 874_800n,
  /** Pool-price observations are kept per bucket of 15 minutes; the window is the current and previous bucket. */
  OBS_BUCKET_SECS: 900,
  /** A buyback needs observations spanning at least a minute (observe, wait a minute, run). */
  OBS_MIN_SPAN_SECS: 60,
  /** A keeper may size a buyback down to 1% of the pool's SOL (or the node's whole amount, if smaller). */
  KEEPER_MIN_POOL_BPS: 100,
  /**
   * Size of the `Autopilot` account (discriminator included): 1,244 bytes
   * since audit round 4 (`active_auth`, `active_activate_at` and
   * `partial_spent` appended; VERSION stays 1).
   */
  ACCOUNT_LEN: 1_244,
  /**
   * Byte offsets in the `Autopilot` account (discriminator included) of the
   * fields a verifier reads directly (programs/noised-autopilot
   * src/state.rs; tests/integration/vectors/programmable.json
   * `parameters.autopilotAccount`).
   */
  OFFSETS: {
    version: 8,
    bump: 9,
    treasuryBump: 10,
    launch: 11,
    mint: 43,
    dammPool: 75,
    activeGraph: 107,
    pendingGraph: 139,
    pendingActivateAt: 171,
    pendingOperator: 179,
    activatedAt: 211,
    frozen: 219,
    operator: 220,
    authMarks: 252,
    seq: 372,
    refSqrtPrice: 380,
    refUpdatedAt: 396,
    refAllowance: 404,
    refAllowanceAt: 412,
    observations: 420,
    tipEpochStart: 516,
    tipsInEpoch: 524,
    nodes: 532,
    /** Audit 4 (A4-S): the Authorization that activated the running graph. */
    activeAuth: 1_076,
    /** Audit 4 (A4-S): the `activate_at` that authorization signed (i64). */
    activeActivateAt: 1_108,
    /** Audit 4 (A4-2): what keepers' partial buybacks moved of each node's open run ([u64; 16]). */
    partialSpent: 1_116,
  },
  /** Rent the 168 bytes audit round 4 appended add to `init_autopilot` (lamports, at 6,960 lamports per byte). */
  A4_EXTRA_RENT_LAMPORTS: 1_169_280n,
  /** Remaining accounts of a buyback `run`: DAMM v2's pool authority, token A vault, token B vault, event authority, program. */
  BUYBACK_ACCOUNTS: 5,
} as const;

/** Display codes a rule can carry (0..=63). Named ones have plain-English text. */
export const RULE_CODES = {
  RULE: 0,
  BOT: 1,
  SNIPER: 2,
  WHALE: 3,
  TEAM: 4,
  ALLOWLIST: 5,
  BLOCKLIST: 6,
  P2P: 7,
  EARLY: 8,
  ROUTER: 9,
} as const;
export type RuleCodeName = keyof typeof RULE_CODES;

/** What a holder sees when a rule with this code refuses a transfer. */
export const RULE_CODE_TEXT: Readonly<Record<number, string>> = {
  0: "Not allowed by a launch rule",
  1: "Looks like a bot transaction",
  2: "Sniping protection",
  3: "Too large for one wallet right now",
  4: "Team wallets can't do this during the launch",
  5: "Only listed wallets can do this right now",
  6: "This wallet is blocked during the launch",
  7: "Wallet-to-wallet transfers are limited right now",
  8: "Too early for this",
  9: "Only listed apps can do this right now",
};

/**
 * Well-known programs a rule may name as the app a transfer is made through
 * (TOP_PROGRAM_IN), by address. Explanations name an app only through this
 * table (and the Noised vault and shield, `RULES_SKIPPED_PROGRAMS`, by
 * their own names), never by a label the creator typed.
 */
export const KNOWN_PROGRAMS: Readonly<Record<string, string>> = {
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora's bonding curve",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora's DAMM v2 pool",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
};

/**
 * The Noised vault program (holders' post-quantum custody: withdrawals and
 * releases). Same id as programs/noised-hook `VAULT_PROGRAM_ID` and the SDK's
 * `PROGRAM_IDS.vault`.
 */
export const NOISED_VAULT_PROGRAM = "7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb";
/**
 * The Noised shield program (holders' privacy: wraps and unwraps). Same id as
 * programs/noised-hook `SHIELD_PROGRAM_ID` and the SDK's `PROGRAM_IDS.shield`.
 */
export const NOISED_SHIELD_PROGRAM = "BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9";
/**
 * Programs whose transfers the creator's rules never touch (the hook's
 * `creator_rules`, review 4 R1): when the transaction's current TOP-LEVEL
 * instruction belongs to one of them, the rule set is skipped and only the
 * built-in launch guard applies. Residual: a transfer routed through them
 * also escapes anti-bot rules (never the built-in guard); a call into them
 * made by another program's CPI has that program as its top-level
 * instruction, so the rules still apply to it.
 *
 * Not in `KNOWN_PROGRAMS`: that table lists apps a buy is made through, and a
 * rule naming one of these could never apply.
 */
export const RULES_SKIPPED_PROGRAMS: readonly string[] = Object.freeze([NOISED_VAULT_PROGRAM, NOISED_SHIELD_PROGRAM]);

/** The hook's error for a rule refusal (appended after 6010). */
export const RULE_DENIED = {
  NAME: "RuleDenied",
  MESSAGE: "Launch rule: this transfer is not allowed right now",
} as const;

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const DEFAULT_TOKEN_DECIMALS = 6;
export const U64_MAX = (1n << 64n) - 1n;

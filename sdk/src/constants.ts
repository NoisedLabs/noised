/**
 * Program ids and on-chain constants (docs/SPEC.md §0, §1.2, §3), mirrored
 * from the programs' sources. `test/sources.test.ts` re-reads the Rust
 * sources and fails if any value here drifts.
 */
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_IDS = {
  launchpad: new PublicKey("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc"),
  hook: new PublicKey("cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia"),
  vault: new PublicKey("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb"),
  shield: new PublicKey("BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9"),
  dbc: new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"),
  dammV2: new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"),
  /** Noised Autopilot: PXG1 graphs that run a launch's treasury (programs/noised-autopilot). */
  autopilot: new PublicKey("D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx"),
} as const;

export type ProgramName = keyof typeof PROGRAM_IDS;

/** Wrapped SOL (SPL Token): no mint or freeze authority. */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export type Cluster = "mainnet" | "devnet" | "localnet";

/** `id` is the cluster byte of the PQ key-derivation path (SPEC §3). */
export const CLUSTERS: Readonly<Record<Cluster, { readonly id: number; readonly label: string }>> = {
  mainnet: { id: 0, label: "Mainnet" },
  devnet: { id: 1, label: "Devnet" },
  localnet: { id: 2, label: "Localnet" },
};

/** Other well-known accounts. */
export const KNOWN_ACCOUNTS = {
  token2022: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  splToken: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  associatedToken: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  system: new PublicKey("11111111111111111111111111111111"),
  computeBudget: new PublicKey("ComputeBudget111111111111111111111111111111"),
  bpfLoaderUpgradeable: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  sysvarInstructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
  /** SPL Memo v2: the vault CPIs it before paying a Token-2022 account that requires memos. */
  memo: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  /** DBC `pool_authority` PDA: owns DBC vaults and is the transfer-hook authority of DBC mints. */
  dbcPoolAuthority: new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"),
  dbcEventAuthority: new PublicKey("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF"),
  dammV2PoolAuthority: new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"),
  dammV2EventAuthority: new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet"),
} as const;

/** PDA seeds, byte for byte as in the programs (SPEC §1.1, §2, §3). */
export const SEEDS = {
  protocol: "protocol",
  launch: "launch",
  authority: "authority",
  batch: "batch",
  dbcConfig: "dbc-config",
  certificate: "certificate",
  commit: "commit",
  /** `["identity", SHA256(0x21 || lms_pk)]`: a creator's post-quantum identity and its one-time-leaf bitmap. */
  identity: "identity",
  /** `["attestation", launch]`: the launch's post-quantum attestation. */
  attestation: "attestation",
  /** `["payout-vault", launch, vault]`: what the commits naming a PQ vault as token owner committed together. */
  payoutVault: "payout-vault",
  /** `["metadata", launch, metadata_hash]`: a token's metadata record (`TokenMeta`), at the address its content hashes to. */
  metadata: "metadata",
  hookAuthority: "hook-authority",
  hookPolicy: "policy",
  extraAccountMetas: "extra-account-metas",
  dbcPool: "pool",
  dbcTokenVault: "token_vault",
  vault: "vault",
  payout: "payout",
  shield: "shield",
  shieldAuthority: "shield-authority",
  zMint: "z-mint",
  dammPool: "pool",
  dammPosition: "position",
  dammPositionNftAccount: "position_nft_account",
  /** `["autopilot", launch]` (autopilot program): a launch's autopilot. */
  autopilot: "autopilot",
  /** `["treasury", launch]` (autopilot program): the treasury authority, owner of its wSOL and token accounts. */
  autopilotTreasury: "treasury",
  /** `["graph", launch, graph_hash]` (autopilot program): a published PXG1 graph, at the address of its content. */
  graphRecord: "graph",
  /** `["auth", launch, [kind], payload_hash]` (launchpad): a post-quantum authorization (`pq_authorize`). */
  authorization: "auth",
  /** `["rules", launch, rules_hash]` (launchpad): a launch's creator rules (`LaunchRules`, `publish_rules`), at the address its content hashes to. */
  launchRules: "rules",
} as const;

/** Launchpad safety-policy bounds (programs/noised-launchpad/src/constants.rs). */
export const POLICY = {
  /**
   * Version 3: the token's metadata (name, symbol, uri mode and document) is
   * an on-chain record the attestation signs, and the mint's metadata is
   * checked against it after the pool CPI (`METADATA_ONCHAIN`). Since
   * version 2: PQ attestation required, attested launch window, 60 s commit
   * floor, 600 s execution window, batch-cap floors, payout vaults capped.
   */
  SAFETY_POLICY_VERSION: 3,
  BPS_DENOMINATOR: 10_000,
  /**
   * Window after the commit window in which the batch must execute; the
   * snipe shield lasts until the batch executes (it then ends at once) or
   * until this window ends. Keepers still need priority fees and tight
   * compute limits: anyone can contend the batch's write locks.
   */
  EXECUTION_GRACE_SECS: 600,
  /** Shortest commit window (seconds). */
  MIN_OPEN_DELAY: 60,
  MAX_OPEN_DELAY: 1_800,
  MAX_GUARD_SECS: 72 * 3_600,
  LAMPORTS_PER_SOL: 1_000_000_000n,
  MIN_THRESHOLD: 1_000_000_000n,
  MAX_THRESHOLD: 100_000n * 1_000_000_000n,
  MAX_PLATFORM_FEE_BPS: 5_000,
  /** A non-zero `batchTotalCap` is at least `migrationQuoteThreshold / 10` (integer division). */
  MIN_BATCH_TOTAL_CAP_DIVISOR: 10n,
  /** A non-zero `batchWalletCap` is at least the resolved total cap / 200 (integer division). */
  MIN_BATCH_WALLET_CAP_DIVISOR: 200n,
  MIN_TOKEN_DECIMALS: 6,
  MAX_TOKEN_DECIMALS: 9,
  /** DBC accepts 16; 8 keeps the largest create_launch (with `pq_identity` and both compute-budget instructions) inside a legacy transaction. */
  MAX_CURVE_POINTS: 8,
  MAX_RECIPIENTS: 4,
  /** Smallest non-zero max-wallet: 0.1% of supply (matches the hook's floor). */
  MIN_MAX_WALLET_BPS: 10,
  /** Metadata limits, in UTF-8 bytes (not characters or UTF-16 units); see `METADATA`. */
  MAX_NAME_LEN: 32,
  MAX_SYMBOL_LEN: 10,
  /** An external uri (`METADATA.FLAG_EXTERNAL_URI`): the DAS indexer stores uris in a `varchar(200)`. */
  MAX_URI_LEN: 200,
  /** The metadata record's document (`TokenMeta.doc`). */
  MAX_DOC_LEN: 3_072,
  /** Ceiling on floor base fee + largest dynamic fee once the schedule ended. */
  MAX_TRADING_FEE_BPS: 1_000,
  /**
   * The launch window an attestation signs (`attest_launch`): it lasts
   * 60..=3,600 seconds, must not have ended when the attestation lands and
   * opens at most 7 days (604,800 s) after it lands; any other window only
   * burns the signing leaf. `launch` runs only inside it (inclusive), and
   * anyone may run it then. Unix seconds, never milliseconds.
   */
  MIN_LAUNCH_WINDOW_SECS: 60,
  MAX_LAUNCH_WINDOW_SECS: 3_600,
  MAX_LAUNCH_LEAD_SECS: 7 * 86_400,
} as const;

/** Meteora DBC 0.2.1 validation constants mirrored by the launchpad (`constants::dbc`). */
export const DBC = {
  MIN_SQRT_PRICE: 4_295_048_016n,
  MAX_SQRT_PRICE: 79_226_673_521_066_979_257_578_248_091n,
  FEE_DENOMINATOR: 1_000_000_000n,
  MIN_FEE_NUMERATOR: 2_500_000n,
  MAX_FEE_NUMERATOR: 990_000_000n,
  BASE_FEE_MODE_LINEAR: 0,
  BASE_FEE_MODE_EXPONENTIAL: 1,
  DYNAMIC_BIN_STEP: 1,
  DYNAMIC_BIN_STEP_U128: 1_844_674_407_370_955n,
  U24_MAX: 0xff_ffff,
  VARIABLE_FEE_SCALE: 100_000_000_000n,
  MAX_MIGRATION_FEE_OPTION: 5,
  COLLECT_FEE_MODE_QUOTE: 0,
  MIGRATION_OPTION_DAMM_V2: 1,
  ACTIVATION_TYPE_TIMESTAMP: 1,
  TOKEN_TYPE_TOKEN_2022: 1,
  TOKEN_UPDATE_AUTHORITY_IMMUTABLE: 1,
  SWAP_MODE_EXACT_IN: 0,
  SWAP_MODE_PARTIAL_FILL: 1,
} as const;

/** The Launch Guard hook's own hard bounds (programs/noised-hook/src/rules.rs `bounds`). */
export const HOOK_BOUNDS = {
  MAX_GUARD_SECS: 72 * 60 * 60,
  MAX_SNIPE_SHIELD_SECS: 60 * 60,
  MIN_MAX_WALLET_DIVISOR: 1_000n,
  MIN_MAX_BUY_DIVISOR: 10_000n,
  MAX_EXEMPT: 4,
} as const;

/** How transfers of a Noised-hooked mint are wired (programs/noised-hook/src/lib.rs, noised-launchpad/src/hook_accounts.rs). */
export const LAUNCH_GUARD = {
  /**
   * Anchor discriminator of the launchpad's `execute_batch`
   * (`sha256("global:execute_batch")[..8]`). During the snipe shield the hook
   * lets a buy through only inside this top-level instruction.
   */
  EXECUTE_BATCH_DISCRIMINATOR: [112, 159, 211, 51, 238, 70, 212, 60] as readonly number[],
  /** Extra accounts in the meta list: the policy PDA and the instructions sysvar. */
  EXTRA_METAS: 2,
  /** Hook accounts of a transfer: meta list, policy, instructions sysvar, hook program (`HOOK_ACCOUNT_COUNT`). */
  HOOK_ACCOUNT_COUNT: 4,
} as const;

/**
 * The Launch Guard hook's errors (programs/noised-hook/src/lib.rs
 * `HookError`, 6000 + variant index). `MutableOwner` (audit round 3 F2):
 * while the guard is on, a transfer that is not a sell into a token account
 * without the ImmutableOwner extension is refused; the SDK's builders refuse
 * such destinations first (`buildSwapTx`, `buildReleaseToTx`).
 */
export const HOOK_ERRORS = {
  SnipeShield: 6000,
  TransfersLocked: 6001,
  MaxBuy: 6002,
  MaxWallet: 6003,
  WrongHookProgram: 6004,
  PolicyMismatch: 6005,
  InvalidPolicy: 6006,
  InvalidPool: 6007,
  MalformedTokenAccount: 6008,
  NotInBatch: 6009,
  MutableOwner: 6010,
  /** A creator launch rule (PXR1, stored in the policy) refused the transfer; the log names the rule: "Launch rule {i} (code {c}) refused the transfer". */
  RuleDenied: 6011,
  /** `create_policy`: the rule bytes do not verify for the guard. */
  InvalidRules: 6012,
} as const;

/** DAMM v2 fixed fee tier (bps) of each `migration_fee_option` (0..=5). */
export const MIGRATION_FEE_TIERS_BPS: readonly number[] = [25, 30, 100, 200, 400, 600];

/**
 * DAMM v2 configs Meteora's DBC SDK uses for each fixed migration fee option
 * (`DAMM_V2_MIGRATION_FEE_ADDRESS`, MIT-licensed SDK). DBC 0.2.1 validates
 * the config by content, so these are the canonical ones, not the only
 * possible ones; `verifyLaunch` warns when a pool came from another config.
 */
export const DAMM_V2_MIGRATION_CONFIGS: readonly PublicKey[] = [
  new PublicKey("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd"),
  new PublicKey("2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k"),
  new PublicKey("Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp"),
  new PublicKey("2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq"),
  new PublicKey("AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD"),
  new PublicKey("DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u"),
];

/**
 * Certificate check bits (SPEC §1.5, state.rs `checks`); all twelve are set
 * on every certificate. A version-4 certificate may also carry the
 * informational `CERTIFICATE_RULES_BOUND` (4,096): test
 * `(checks & CERTIFICATE_ALL_CHECKS) === CERTIFICATE_ALL_CHECKS`
 * (`certificateChecksComplete`), never `checks === 4095`.
 */
export const CERTIFICATE_CHECKS = {
  MINT_AUTHORITY_NONE: 1,
  FREEZE_AUTHORITY_NONE: 2,
  METADATA_UPDATE_AUTHORITY_NONE: 4,
  METADATA_POINTER_AUTHORITY_NONE: 8,
  EXTENSION_SET_EXACT: 16,
  HOOK_IS_NOISED: 32,
  LP_PERMANENTLY_LOCKED: 64,
  NO_MIGRATION_FEE: 128,
  NO_CREATOR_ALLOCATION: 256,
  QUOTE_IS_WSOL: 512,
  /** The launch's identity signed its configuration, metadata and window with an LMS signature verified on-chain. */
  PQ_ATTESTED: 1024,
  /** The mint's TokenMetadata, re-read after the pool CPI, holds exactly the attested record's name, symbol and derived uri, and nothing else. */
  METADATA_ONCHAIN: 2048,
} as const;
/** Every check `launch` requires (`checks::ALL`): the twelve bits above. */
export const CERTIFICATE_ALL_CHECKS = 4095;
/**
 * `checks::RULES_BOUND` (amendment A2): informational, never required. Set
 * on a version-4 certificate in addition to the twelve bits when the launch
 * has creator rules and the hook policy, re-read after it was written, holds
 * exactly the attested rules record's bytes (`checks` = 8,191).
 */
export const CERTIFICATE_RULES_BOUND = 4096;

/**
 * Whether a certificate's `checks` holds every bit `launch` requires:
 * `(checks & 4095) === 4095`. Never compare with `=== 4095`: a certificate
 * with creator rules also carries `RULES_BOUND` (8,191).
 */
export function certificateChecksComplete(checks: number): boolean {
  return Number.isInteger(checks) && (checks & CERTIFICATE_ALL_CHECKS) === CERTIFICATE_ALL_CHECKS;
}

/**
 * The `Certificate` account (state.rs): version 4 appends `rules_hash` (the
 * attested creator rules, all zero for none) to version 3, which added
 * `metadata`, the address of the attested `TokenMeta` record. Readers accept
 * both (`V3_ACCOUNT_LEN` 487, `ACCOUNT_LEN` 519); the program writes 4.
 */
export const CERTIFICATE = {
  VERSION: 4,
  /** Discriminator included (version 4). */
  ACCOUNT_LEN: 519,
  /** Version 3 (no `rules_hash`): what launches before P1c hold. */
  V3_VERSION: 3,
  V3_ACCOUNT_LEN: 487,
  /** `checks` u32 at 187..191, `policy_version` u16 at 411..413, `metadata` at 455..487, `rules_hash` at 487..519 (version 4). */
  CHECKS_OFFSET: 187,
  POLICY_VERSION_OFFSET: 411,
  METADATA_OFFSET: 455,
  RULES_HASH_OFFSET: 487,
} as const;

/**
 * A launch's creator rules, on-chain (`LaunchRules`, `publish_rules`;
 * state.rs, pq.rs): the PXR1 bytes whole at `["rules", launch, rules_hash]`,
 * `rules_hash = SHA256("PHX-RULES-V1" || bytes)` (all zero: no rules).
 * Verified against the launch's guard when written; never modified or
 * closed. Account: discriminator, version u8 at 8, bump 9, launch 10..42,
 * rules_hash 42..74, u32 length at 74, bytes from 78: `78 + len` bytes.
 */
export const LAUNCH_RULES = {
  SEED: "rules",
  VERSION: 1,
  /** `sha256("account:LaunchRules")[..8]`. */
  DISCRIMINATOR: [0xee, 0x49, 0x47, 0x1d, 0xe7, 0x30, 0x27, 0x8d] as readonly number[],
  OFFSETS: { VERSION: 8, BUMP: 9, LAUNCH: 10, RULES_HASH: 42, LEN: 74, BYTES: 78 },
  FIXED_LEN: 78,
  /** `noised_rules::rules::MAX_LEN`: the largest PXR1 rule set. */
  MAX_RULES_LEN: 1_228,
  HASH_TAG: "PHX-RULES-V1",
  /** `publish_rules`: the bytes do not verify (PXR1) for the launch's guard. */
  ERRORS: { InvalidRules: 6048 },
  /** Legacy compute limit of `publish_rules` (measured 11.1k CU for 286 bytes to 17.6k for the largest set). */
  PUBLISH_COMPUTE_UNITS: 40_000,
  /** v1 loaded-accounts-data limit of `publish_rules` (the launchpad program, the launch and the system program, with margin). */
  PUBLISH_LOADED_ACCOUNTS_BYTES: 2 * 1024 * 1024,
} as const;

/**
 * The Launch Guard policy (`HookPolicy`, programs/noised-hook state.rs):
 * version 2 stores the creator rules after the fixed fields: u32 length at
 * 275, the PXR1 bytes from 279; the account is exactly `279 + len` bytes.
 */
export const HOOK_POLICY = {
  VERSION: 2,
  /** `sha256("account:HookPolicy")[..8]`. */
  DISCRIMINATOR: [0x67, 0x72, 0xf6, 0x55, 0x0f, 0x16, 0xbe, 0xc3] as readonly number[],
  RULES_LEN_OFFSET: 275,
  RULES_OFFSET: 279,
  /** A policy without rules. */
  BASE_LEN: 279,
} as const;

/**
 * The launchpad's generic post-quantum authorization (`pq_authorize`,
 * `Authorization`; programs/noised-launchpad state.rs, pq.rs, the
 * autopilot's launchpad.rs): an LMS signature by the launch's identity over
 * `"PHX-AUTH-V1" || program || launch || creator || u8 kind || payload_hash`
 * (140 bytes), kept whole at `["auth", launch, [kind], payload_hash]`
 * (2,669 bytes). Written once, by the first such signature of the launch's
 * identity; any other landing only burns its leaf (the bitmap is shared with
 * attestations).
 */
export const AUTHORIZATION = {
  VERSION: 1,
  /** `sha256("account:Authorization")[..8]`. */
  DISCRIMINATOR: [0x03, 0x44, 0xa8, 0xf3, 0xc3, 0xa8, 0x20, 0x4b] as readonly number[],
  MESSAGE_TAG: "PHX-AUTH-V1",
  MESSAGE_LEN: 140,
  ACCOUNT_LEN: 2_669,
  OFFSETS: { VERSION: 8, BUMP: 9, LAUNCH: 10, PQ_IDENTITY: 42, KIND: 74, PAYLOAD_HASH: 75, MESSAGE_HASH: 107, UNIX_TIME: 139, SLOT: 147, LEAF: 155, SIG_LEN: 157, SIGNATURE: 161 },
  /** The kinds the autopilot reads (the launchpad gives `kind` no meaning). */
  KINDS: { GRAPH_ACTIVATE: 1, GRAPH_FREEZE: 2, OPERATOR_REVOKE: 3 },
  /** v1 config words of `pq_authorize` (measured 91.0k-101.4k CU; the transaction is about 2,924-3,020 bytes). */
  COMPUTE_UNITS: 300_000,
  LOADED_ACCOUNTS_BYTES: 2 * 1024 * 1024,
} as const;

/**
 * Post-quantum creator identities and launch attestations (PQ v2;
 * crates/noised-lmots `lms.rs`, programs/noised-launchpad `pq.rs`,
 * `state.rs`). An identity is an RFC 8554 `LMS_SHA256_M32_H10` key over
 * `LMOTS_SHA256_N32_W4`: 1,024 one-time leaves, each accepted on-chain once.
 */
export const PQ_IDENTITY = {
  LMS_TYPE: 6,
  LMOTS_TYPE: 3,
  HEIGHT: 10,
  LEAVES: 1_024,
  /** `u32be(6) || u32be(3) || I(16) || T[1](32)`. */
  PUBLIC_KEY_LEN: 56,
  /** `u32be(q) || LM-OTS signature (4 + 32 + 67 * 32) || u32be(6) || path (10 * 32)`. */
  SIGNATURE_LEN: 2_508,
  /** Domain byte of `identity_id = SHA256(0x21 || public_key)` (the identity PDA seed). */
  IDENTITY_ID_DOMAIN: 0x21,
  // protocol constant: kept from the original name; changing it changes every key derived from a phrase or passkey
  /** Identity derivation from a recovery phrase's master seed: `SEED = SHA256(seedTag || ...)`, `I = SHA256(idTag || ...)[..16]`. */
  IDENTITY_SEED_TAG: "phalanx/pq/identity/v1/seed",
  IDENTITY_ID_TAG: "phalanx/pq/identity/v1/id",
  // protocol constant: kept from the original name; changing it changes every leaf choice and the vectors
  /**
   * The RETIRED public leaf probe (v1): `u16be(SHA256(tag || I || message)[0..2]) mod 1024`.
   * Anyone could compute it, and the probe skipped every leaf an RPC reported as used, so a
   * dishonest RPC could steer a second device onto the leaf of a withheld signature (audit 4,
   * ID-F1). Kept for the reference vectors only; the SDK chooses leaves with the secret probe v2.
   */
  LEAF_PROBE_TAG: "phalanx/pq/identity/leaf",
  /**
   * The secret leaf probe (audit 4, ID-F1a, client-side only: the program never checks it):
   * `start = u16be(HMAC-SHA256(probeKey, tag || message)[0..2]) mod 1024`, then the first leaf
   * (+1, wrapping) absent from the ledger and from this process's signatures; RPC bits never move it.
   */
  LEAF_PROBE_V2_TAG: "phalanx/pq/identity/leaf/v2",
  // protocol constants (both probe tags): kept from the original name; changing them changes every leaf choice
  /** The probe key: `probeKey = HMAC-SHA256(SEED, tag || I)` (secret: only the identity's SEED gives it). */
  LEAF_PROBE_KEY_TAG: "phalanx/pq/identity/leaf/v2/key",
  /** Clock sanity (audit 4, ID-F1b): the most seconds the cluster clock may differ from this device's before a signature with a time is refused. */
  CLOCK_SKEW_MAX_SECS: 120,
  /** A freeze approval is signed to expire at most this long after this device's clock (audit 4, ID-F5): 24 hours. */
  FREEZE_MAX_VALID_SECS: 86_400,
  /**
   * Signatures of one launch that never landed with success (unlanded, or landed only burning their leaf) a ledger
   * makes before it refuses a new one without `acknowledgeExtraSignatures` (audit 4, ID-F2): 3 attestation
   * signatures per launch, 3 `pq_authorize` signatures per (launch, kind).
   */
  MAX_UNLANDED_SIGNATURES: 3,
  /** Warn the user once this many leaves of an identity are used. */
  LEAF_WARN_AT_USED: 1_000,
  /** Bytes of an identity's used-leaf bitmap (least significant bit first: `used[q >> 3] & (1 << (q & 7))`). */
  LEAF_BITMAP_LEN: 128,
  /**
   * Message v3: `"PHX-ATTEST-V3" || program || launch || params_hash ||
   * creator || metadata_hash || rules_hash || i64le(not_before) ||
   * i64le(not_after)` (221 bytes; the 189-byte v2 is retired: the program
   * builds only v3, so a v2 signature can never land).
   */
  ATTEST_MESSAGE_TAG: "PHX-ATTEST-V3",
  ATTEST_MESSAGE_LEN: 221,
  /** `metadata_hash_v2` (`METADATA.HASH_TAG`): the hash of the on-chain metadata record the identity signs. */
  METADATA_HASH_TAG: "PHX-META-V2",
  /** Account sizes (discriminator included). */
  IDENTITY_ACCOUNT_LEN: 196,
  /** Attestation v3: launch 10, pq_identity 42, leaf 74, metadata_hash 76, rules_hash 108, message_hash 140, slot 172, not_before 180, not_after 188, sig_len 196, signature 200..2,708. */
  ATTESTATION_ACCOUNT_LEN: 2_708,
  PAYOUT_VAULT_ACCOUNT_LEN: 82,
  /** `Identity::VERSION`: written with the identity's LMS key when its first signature lands (no other version exists). */
  IDENTITY_VERSION: 1,
  /** `Attestation::VERSION` (3: message v3, which binds `rules_hash`); an empty (burn-only) attestation has version 0. */
  ATTESTATION_VERSION: 3,
  /** Byte offsets of the attestation v3 (discriminator included). */
  ATTESTATION_OFFSETS: { VERSION: 8, BUMP: 9, LAUNCH: 10, PQ_IDENTITY: 42, LEAF: 74, METADATA_HASH: 76, RULES_HASH: 108, MESSAGE_HASH: 140, SLOT: 172, NOT_BEFORE: 180, NOT_AFTER: 188, SIG_LEN: 196, SIGNATURE: 200 },
  /** v1 config words for `attest_launch` (measured: at most about 114.5k CU on all 1,024 leaves, projection about 170k; about 785 KB loaded). */
  ATTEST_COMPUTE_UNITS: 300_000,
  ATTEST_LOADED_ACCOUNTS_BYTES: 2 * 1024 * 1024,
} as const;

/**
 * The on-chain metadata record (`TokenMeta`; constants.rs, state.rs, pq.rs,
 * policy.rs): `publish_metadata` writes a token's name, symbol, uri mode,
 * optional external uri and document whole at `["metadata", launch,
 * metadata_hash]`, where `metadata_hash = SHA256("PHX-META-V2" ||
 * u32le(len) name || u32le(len) symbol || u8 flags || u32le(len) uri ||
 * u32le(len) doc)` over UTF-8 bytes; `attest_launch` signs that hash and
 * `launch` gives the mint the record's name, symbol and derived uri. Records
 * are never modified or closed.
 */
export const METADATA = {
  SEED: "metadata",
  /** UTF-8 bytes. */
  MAX_NAME_LEN: 32,
  MAX_SYMBOL_LEN: 10,
  MAX_URI_LEN: 200,
  MAX_DOC_LEN: 3_072,
  /**
   * `flags`: at most one uri mode. Neither (0, the default): the mint's uri
   * is empty. `FLAG_INLINE_URI`: `INLINE_URI_PREFIX + base64(doc)` (do not
   * offer it until the wallet/indexer matrix of METADATA_ONCHAIN.md §2.4
   * passes). `FLAG_EXTERNAL_URI`: the record's own `https://` uri.
   */
  FLAG_INLINE_URI: 1,
  FLAG_EXTERNAL_URI: 2,
  INLINE_URI_PREFIX: "data:application/json;base64,",
  /** An external uri is this prefix and at least one more byte, every byte printable ASCII (0x21..=0x7E). */
  EXTERNAL_URI_PREFIX: "https://",
  /** The inline uri of a `MAX_DOC_LEN` document. */
  MAX_INLINE_URI_LEN: 4_125,
  HASH_TAG: "PHX-META-V2",
  /** `TokenMeta::VERSION`. */
  TOKEN_META_VERSION: 1,
  /** `sha256("account:TokenMeta")[..8]`. */
  TOKEN_META_DISCRIMINATOR: [0x82, 0x57, 0xae, 0x23, 0x15, 0x2c, 0x5c, 0x13] as readonly number[],
  /** Discriminator, version, bump, flags, launch, metadata hash and the four strings' length prefixes; a record is exactly this plus its strings' bytes. */
  TOKEN_META_FIXED_LEN: 91,
  /** Offsets of the fixed fields (discriminator included); the borsh strings name, symbol, uri, doc follow from `NAME`. */
  TOKEN_META_OFFSETS: { VERSION: 8, BUMP: 9, FLAGS: 10, LAUNCH: 11, METADATA_HASH: 43, NAME: 75 },
  /** The largest record: name 32, symbol 10, uri 200 and document 3,072 bytes. */
  MAX_TOKEN_META_LEN: 3_405,
  /** A launched mint is `MINT_BASE_LEN + name + symbol + uri` bytes. */
  MINT_BASE_LEN: 386,
  /** Errors of `publish_metadata`, checked in this order: flags (6045), lengths (6046), name, symbol and external uri (6016), then the uri modes (6045). 6047 is `launch`'s post-condition. */
  ERRORS: { InvalidMetadata: 6016, InvalidMetadataFlags: 6045, MetadataTooLong: 6046, MetadataMismatch: 6047 },
  /** v1 config words of `publish_metadata` (measured 12.7k-23.8k CU; 309-3,621 B). */
  PUBLISH_COMPUTE_UNITS: 100_000,
  PUBLISH_LOADED_ACCOUNTS_BYTES: 2 * 1024 * 1024,
  /** The SDK's document schema (`buildMetadataDoc`): a description of at most this many UTF-8 bytes, an icon of at most `MAX_ICON_SIDE` pixels a side. */
  MAX_DESCRIPTION_LEN: 500,
  MAX_ICON_SIDE: 64,
} as const;

/**
 * How the launchpad recognizes a Noised PQ vault (constants.rs `pq_vault`,
 * `pq::is_vault_of`): an account of the vault program whose data starts with
 * the `Vault` discriminator, holds version 4 at byte 8 and the vault's mint
 * at bytes 10..42. Treasury, fee recipients, commit payout owners and swap
 * recipients may be such vaults; their canonical ATA is the vault's own
 * token account.
 */
export const PQ_VAULT_LAYOUT = {
  DISCRIMINATOR: [211, 8, 232, 43, 2, 152, 117, 119] as readonly number[],
  VERSION: 4,
  VERSION_OFFSET: 8,
  MINT_OFFSET: 10,
} as const;

/** LM-OTS / vault constants (SPEC §3, programs/noised-vault/src/message.rs, state.rs, crates/noised-lmots). */
export const VAULT = {
  /** `Vault::VERSION`: vault v4 (key rotated in place, payouts reserved then released). */
  VERSION: 4,
  /** `Payout::VERSION`. */
  PAYOUT_VERSION: 1,
  MESSAGE_TAG: "PHX-PQV4",
  OP_WITHDRAW: 1,
  /** `8 + 1 + 32 * 3 + 8 + 32 + 8 + 32`. */
  WITHDRAW_MESSAGE_LEN: 185,
  SIGNATURE_LEN: 2176,
  /** `withdraw` instruction data: discriminator, Vec length, signature, recipient, max amount, next key id, next key. */
  WITHDRAW_IX_DATA_LEN: 8 + 4 + 2176 + 32 + 8 + 32 + (16 + 4 + 32),
  // protocol constant: kept from the original name; changing it changes signatures
  /** Domain tag of the deterministic randomizer `C = HMAC-SHA256(SEED, tag | I | u32be(q) | msg)`. */
  RANDOMIZER_TAG: "phalanx/pq/lmots/C",
  /** SIMD-0385 v1 transaction size limit. */
  V1_MAX_TX_BYTES: 4096,
  V1_MAX_ACCOUNTS: 64,
  /**
   * SPEC §3.9's generous compute-unit limit for a withdrawal's v1 config word
   * (also covers a `release` in the same transaction; the Rust vectors use it).
   * The builders default to the tighter measured `VAULT_COMPUTE_UNITS`
   * (pq/vault.ts); pass this as `computeUnitLimit` to get the old value.
   */
  WITHDRAW_COMPUTE_UNITS: 400_000,
  /** Loaded-accounts-data-size limit for a withdrawal's v1 config word (SPEC §3.9). */
  WITHDRAW_LOADED_ACCOUNTS_BYTES: 4 * 1024 * 1024,
  /**
   * A wide compute-unit limit for a legacy `release` / `release_to` (ATA
   * creation, memo, transfer and any hook). The builders default to the
   * tighter measured `VAULT_COMPUTE_UNITS` per mint (pq/vault.ts).
   */
  RELEASE_COMPUTE_UNITS: 300_000,
} as const;

/**
 * Funding for a throwaway withdrawal fee payer: the signature fee, the
 * payout account's rent (about 0.0017 SOL, returned to the fee payer when
 * the payout is released) and, when `release` runs in the same transaction,
 * the recipient's token account if it does not exist yet (about 0.002 SOL),
 * with margin.
 */
export const FEE_PAYER_FUNDING_LAMPORTS = 10_000_000n;

/**
 * Third parties whose keys still matter (docs/SECURITY_GUARANTEES.md, "Who you
 * still trust", state as of 2026-10-08). `verifyLaunch` re-reads the live
 * upgrade authorities and deploy slots and flags any change from these.
 */
export const TRUST_ANCHORS = {
  /** Squads v3 vault of the 4-of-7 Meteora multisig: upgrade authority of DBC and DAMM v2. */
  meteoraUpgradeAuthority: new PublicKey("JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd"),
  meteoraMultisig: new PublicKey("CoEsykatDegLB7pcMJia79JSriDdi71nPnjgeSfw623k"),
  dbcProgramData: new PublicKey("HUfnSSiJxgspQm6C1rkqv6L3XgVtn7AESApgCQpCXCYh"),
  dbcLastDeploySlot: 445_503_633n,
  dammV2ProgramData: new PublicKey("AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH"),
  dammV2LastDeploySlot: 445_230_614n,
  /** Hard-coded admins of DAMM v2 and DBC (create and remove operators). */
  meteoraAdmins: [
    new PublicKey("5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi"),
    new PublicKey("DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX"),
  ],
  /** Squads v3 multisig (4-of-6) and its vault, the Token-2022 upgrade authority. */
  token2022Multisig: new PublicKey("BnD53519LK7QM4ERBGvLedZDe1VoTPgtiBkGPWAACiMZ"),
  token2022UpgradeAuthority: new PublicKey("AeLmXCbPaQHGWRLr2saFsEVfmMNuKnxRAbWCT9P5twgz"),
  token2022ProgramData: new PublicKey("DoU57AYuPFu2QU514RktNPG22QhApEjnKxnBcu4BHDTY"),
} as const;

/** The all-zero address that DBC and Noised treat as "unset". */
export const DEFAULT_PUBKEY = PublicKey.default;

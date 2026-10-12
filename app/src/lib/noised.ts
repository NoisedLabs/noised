/**
 * Noised adapter: the ONLY module the UI uses for chain access.
 *
 * Its API is the SDK's (docs/SPEC.md §4.1 as implemented by @noisedlabs/sdk;
 * test/adapter-api.test.ts checks every name and signature):
 *   - pure functions, constants and types are re-exported from the SDK
 *     unchanged (policy mirror, PDAs, presets, LM-OTS keys and the withdraw
 *     message, the vault-key and LMS leaf ledgers, PQ identities, the v1
 *     wire format). There is no raw one-time signer: a vault key signs only
 *     through the backend's `prepareWithdrawal`, behind the vault-key ledger;
 *   - everything that reads or writes the chain comes from the backend this
 *     build was made with: `#noised-backend` resolves to ./backend/live.ts
 *     (the SDK against the configured RPC) unless the app was built or served
 *     with VITE_NOISED_MOCK=1, which selects the simulated chain in
 *     ./backend/mock.ts. Exactly one of the two is in a bundle; there is no
 *     runtime switch.
 */
import { backend } from "#noised-backend";

// ============================================================ constants ===

export { CLUSTERS, PROGRAM_IDS, WSOL_MINT } from "@noisedlabs/sdk";
export type { Cluster } from "@noisedlabs/sdk";

// =============================================================== launch ===

export { inLaunchWindow, launchPdas, launchPdasFromLaunch, launchPhase, PRESETS, unixNowSecs, validateLaunchParams } from "@noisedlabs/sdk";

// The token's on-chain metadata record (name, symbol, optional document): what the identity signs (by its hash) and
// what `launch` copies into the mint. Never offer a uri mode (METADATA.FLAG_INLINE_URI / FLAG_EXTERNAL_URI) in the UI.
export { METADATA, metadataHashV2, tokenMetaAddress, tokenMetaSpace, tokenUri, validateTokenMeta } from "@noisedlabs/sdk";

// The token's document (description, a small PNG icon, links) and its reading: built and parsed by the SDK, never fetched.
export { buildMetadataDoc, encodeIndexedPng, parseMetadataDoc, validateMetadataDoc } from "@noisedlabs/sdk";

// The launch flow's pure parts: the plan (parameters, record, window, the exact message the identity signs), a new
// window for the same launch (audit round 3 F1), the window rules (60 s must be left when an attestation lands) and
// the errors its steps throw before anything is sent.
export {
  attestationReplaceable,
  AttestPayerFundingError,
  AttestRetryLimitError,
  launchWindowProblems,
  MAX_BURN_ONLY_LANDINGS,
  PendingAttestationError,
  planLaunch,
  PublishPayerFundingError,
  replanLaunchWindow,
  validateLaunchWindow,
} from "@noisedlabs/sdk";

// Quick launch (SDK 0.7.0): a whole launch planned from the short form (the Fair preset with the chosen fee, the fee
// recipients: the wallet, the launch's own Autopilot treasury or a split, the record, the daily buyback-and-burn graph).
export { planQuickLaunch, QUICK_LAUNCH_BUYBACK_DEFAULTS, QUICK_LAUNCH_FEE_BPS_RANGE } from "@noisedlabs/sdk";
export type { QuickFeeDestination, QuickLaunchInput, QuickLaunchPlan } from "@noisedlabs/sdk";

export const {
  buildClaimFeesTx,
  buildClaimLpFeesTx,
  buildClaimTx,
  buildCommitTx,
  buildCreateLaunchTx,
  buildDistributeTx,
  buildExecuteBatchTx,
  buildLaunchTx,
  buildSwapTx,
  checkFeeRecipients,
  fetchAttestation,
  fetchCommit,
  fetchLaunch,
  fetchLaunchByMint,
  fetchPayoutVault,
  listLaunches,
} = backend;

export const {
  buildFundThrowawayPayerTx,
  buildPlannedAttestTx,
  buildPlannedCreateLaunchTx,
  buildPlannedPublishTx,
  buildSweepPayerTx,
  confirmAttestation,
  fetchTokenMetaForLaunch,
  fetchTokenMetaForMint,
  getLaunchFlowStatus,
  landOrBurnPending,
  launchPayerLamports,
  rentExemptLamports,
  sendAttestLaunchTx,
  sendPublishMetadataTx,
  throwawayPayerFunding,
  verifyAttestation,
  waitForTokenMeta,
} = backend;

// =============================================================== verify ===

export const { verifyLaunch, checkQsl1 } = backend;

// =================================================================== pq ===

export { deriveVaultKey, generateRecoveryPhrase, lmots, masterFromPhrase, payoutAddress, vaultAddress, withdrawMessage } from "@noisedlabs/sdk";

// The durable one-signature-per-key vault-key ledger (lib/ledger.ts keeps one per browser profile), its
// authenticated export / import between devices, and the errors of the signing path.
export {
  ClusterMismatchError,
  completeVaultKeyRecords,
  createMemoryVaultKeyLedger,
  createVaultKeyLedger,
  exportVaultKeyRecords,
  importVaultKeyRecords,
  IncompleteSearchError,
  LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT,
  RecipientConfirmationError,
  recordPendingWithdrawal,
  VAULT_KEY_LEDGER_EXPORT_FORMAT,
  VaultKeyInUseError,
  VaultLedgerError,
  withdrawalFromRecord,
} from "@noisedlabs/sdk";

// Post-quantum creator identities (LMS) and their one-message-per-leaf ledger.
export { leafLedger, lms, PQ_IDENTITY, pqIdentity } from "@noisedlabs/sdk";

// SDK 0.9.0 (audit 4): what refuses a quantum signature before anything is signed, and its confirmations.
//   - UnknownLeavesError: the key's on-chain record shows signatures this browser never made (another device or app):
//     import that device's records first; `acknowledgeUnknownLeaves` only after an explicit confirmation of the count;
//   - ClockSkewError: the network's clock and this device's disagree (by more than CLOCK_SKEW_MAX_SECS);
//   - SignatureCapError: MAX_UNLANDED_SIGNATURES earlier signatures never landed (confirm one more, or land them).
// Signed times are shown as absolute dates (unixToIso, unixToUtcText); a freeze approval lasts at most
// FREEZE_MAX_VALID_SECS (24 hours). signingLockName names the per-launch signing lock (navigator.locks in a browser).
export {
  acknowledgeUnknownLeaves,
  CLOCK_SKEW_MAX_SECS,
  ClockSkewError,
  FREEZE_MAX_VALID_SECS,
  MAX_UNLANDED_SIGNATURES,
  SignatureCapError,
  signingLockName,
  UnknownLeavesError,
  unixToIso,
  unixToUtcText,
} from "@noisedlabs/sdk";

export const {
  buildDepositTx,
  buildOpenVaultTx,
  buildReleaseToTx,
  buildReleaseTx,
  buildWithdrawTx,
  buildWithdrawTxWithFallback,
  checkRecipient,
  checkVaultMint,
  fetchPayout,
  fetchVault,
  findPendingWithdrawal,
  listPayouts,
  prepareWithdrawal,
  scanVaults,
} = backend;

// =============================================================== shield ===

export { shieldAddresses } from "@noisedlabs/sdk";

export const { buildCreateShieldTx, buildUnwrapTx, buildWrapTx, fetchShield } = backend;

// ========================================================== rpc helpers ===

export const { getSolBalance, getTokenBalance, getTokenSupply, sendAndConfirm, simulateAndExplain } = backend;

// ================================================================ types ===

export type {
  AnyTransaction,
  AttestationAccount,
  AttestationOutcome,
  AttestationVerification,
  AttestLaunchReady,
  AttestLaunchTx,
  BaseFeeParams,
  BurnOnlyLanding,
  BurnReason,
  BatchFill,
  CertificateAccount,
  CheckRecipientOptions,
  CheckStatus,
  CommitAccount,
  CommitOptions,
  ComputeBudgetOptions,
  CurvePoint,
  DynamicFeeParams,
  FeeRecipient,
  FeeSummary,
  LaunchAccount,
  LaunchFlowStatus,
  LaunchFlowStep,
  LaunchMetadata,
  LaunchParams,
  LaunchParamsInput,
  LaunchPdas,
  LaunchPhase,
  LaunchPlan,
  LaunchPreset,
  LaunchState,
  LaunchStatus,
  LaunchWindow,
  LeafLedger,
  LeafLedgerExport,
  LeafLedgerStore,
  LedgerLock,
  LmotsPublicKey,
  MarketSnapshot,
  MetadataDocInput,
  MetadataIcon,
  MetadataLink,
  MetadataLinks,
  ParsedMetadataDoc,
  ParsedWithdrawMessage,
  PayoutAccount,
  PayoutListing,
  PayoutVaultAccount,
  PendingWithdrawal,
  PendingWithdrawalContinuation,
  PendingWithdrawalSearch,
  PendingWithdrawalSearchOptions,
  PlanLaunchInput,
  PqIdentity,
  PqMaster,
  PqOrigin,
  PreparedWithdrawal,
  PresetName,
  ProgramInvocation,
  PublishMetadataReady,
  PublishMetadataTx,
  RecipientCheck,
  RecipientConfirmation,
  RecipientConfirmationProblem,
  ScannedVault,
  ShieldAccount,
  ShieldAddresses,
  SimulationReport,
  SwapOptions,
  SwapQuote,
  SwapSide,
  ThrowawayPayerFunding,
  TokenMetaAccount,
  TokenMetaInput,
  TokenMetaRecord,
  TrustedParty,
  TrustedPartyKind,
  ValidationResult,
  VaultAccount,
  VaultInfo,
  VaultKeyImportSummary,
  VaultKeyLedger,
  VaultKeyLedgerExport,
  VaultKeyMaterial,
  VaultKeyRecord,
  VaultMintCheck,
  VerificationCheck,
  VerificationReport,
  VerifiedMetadata,
  WithdrawalRequest,
  WithdrawTx,
  WithdrawTxArgs,
  WithdrawTxWithFallback,
} from "@noisedlabs/sdk";
export type { ClusterCheck, FeeRecipientsCheck, MintInfo, ProgramStatus } from "./backend/types";

// =========================================================== app extras ===
// Not named in SPEC §4.1: pure SDK helpers the pages use, and app controls.

export {
  associatedTokenAddress,
  attestationAddress,
  autopilotAddress,
  autopilotTreasuryAddress,
  batchOutcome,
  batchShare,
  capFromBps,
  certificateAddress,
  CERTIFICATE_ALL_CHECKS,
  CERTIFICATE_CHECKS,
  CERTIFICATE_RULES_BOUND,
  certificateChecksComplete,
  commitAddress,
  DAMM_V2_MIGRATION_CONFIGS,
  DBC,
  decodeV1Transaction,
  designCurve,
  dynamicFeeFor,
  estimateSupply,
  expectedBatchFill,
  extraAccountMetaListAddress,
  FEE_PAYER_FUNDING_LAMPORTS,
  feeNumeratorToPercent,
  feeScheduleDuration,
  feeSummary,
  GENESIS_KEY_INDEX,
  hookPolicyAddress,
  identityAddressFromId,
  isBip39Word,
  keySequence,
  KNOWN_ACCOUNTS,
  launchAddress,
  launchParamsHash,
  masterFingerprint,
  MIGRATION_FEE_TIERS_BPS,
  nextKeyIndex,
  normalizePhrase,
  parseWithdrawMessage,
  payoutVaultAddress,
  phraseProblems,
  POLICY,
  priceFromSqrtPrice,
  RECOVERY_PHRASE_WORDS,
  splitFees,
  sqrtPriceFromPrice,
  TRADING_FEE_CEILING_NUMERATOR,
  TRUSTED_PARTIES,
  VAULT,
  WITHDRAW_MESSAGE_FIELDS,
} from "@noisedlabs/sdk";

export const {
  buildFundFeePayerTx,
  buildRefundFeePayerTx,
  chainUnixTime,
  checkCluster,
  demoMints,
  demoPasskeyMaster,
  fundDemoWallet,
  getMintInfo,
  notifyChainChanged,
  programStatuses,
  resetDemoState,
  subscribeToChainChanges,
} = backend;

/** "mock": simulated chain (VITE_NOISED_MOCK=1); nothing is sent and wallets are never asked to sign. "live": the real cluster. */
export const ADAPTER_MODE: "mock" | "live" = backend.mode;

// ========================================================= programmable ===
// Launch rules and Autopilot (PROGRAMMABLE_V1 §2-§4). The pure side (formats, DSLs, verifiers, simulators) is
// lib/programmable.ts; these read and write the chain, through the same backend as everything else.

/**
 * False while custom rules and Autopilot are not live on this build's cluster: the pages then show them as "coming
 * soon" and never let anyone add rules or switch an autopilot on. True on the simulated chain and, since SDK 0.7.0 (the
 * P1c programs), on live builds.
 */
export const PROGRAMMABLE_AVAILABLE: boolean = backend.programmable.available;

/** The programmable chain access as one object (the launch flow publishes and binds custom rules through it). */
export const programmable = backend.programmable;

export const {
  bindRulesToAttestation,
  buildActivateGraphTx,
  buildApplyPendingTx,
  buildFreezeGraphTx,
  buildInitAutopilotTx,
  buildPqAuthorizeTx,
  buildPublishGraphTx,
  buildPublishRulesTx,
  buildRevokeOperatorTx,
  buildRunStepTx,
  checkGraphRecipients,
  fetchAuthorization,
  fetchAutopilot,
  fetchGraphBytes,
  fetchIdentityLeaves,
  fetchLaunchRules,
  fetchMigrationPrice,
  fetchRulesRecord,
  findDueSteps,
  listAutopilotRuns,
  rulesRecordRent,
} = backend.programmable;

export type { AuthorizationInfo, AutopilotInfo, AutopilotNodeState, AutopilotRun, DueStep, GraphRecipientsCheck, LaunchRulesInfo, RulesRecord, RunCosts } from "./backend/programmable";

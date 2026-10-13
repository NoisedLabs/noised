/**
 * The chain backend behind the adapter (src/lib/noised.ts).
 *
 * Two implementations exist and exactly one is compiled into a build:
 *   - ./live.ts (default): @noisedlabs/sdk against the configured RPC endpoint;
 *   - ./mock.ts (only when built with VITE_NOISED_MOCK=1): a simulated chain
 *     in the browser, for UI development without a cluster.
 * vite.config.ts aliases `#noised-backend` to one of them; the other is not
 * part of the bundle. Both are typed as `ChainBackend`, whose SDK members are
 * the SDK's own function types, so the mock cannot drift from the SDK's API.
 */
import type * as Sdk from "@noisedlabs/sdk";
import type { Connection, PublicKey } from "@solana/web3.js";

import type { QslVerdict } from "../qsl";
import type { ProgrammableBackend } from "./programmable";

/** What the app needs to know about any mint it shows amounts for. */
export interface MintInfo {
  address: PublicKey;
  /** Owner program: SPL Token or Token-2022. */
  tokenProgram: PublicKey;
  decimals: number;
  supply: bigint;
  /** Display label from Token-2022 metadata (sanitized) or a well-known mint; null if unknown. */
  symbol: string | null;
  name: string | null;
}

/** Live deployment status of one program the app talks to. */
export interface ProgramStatus {
  label: string;
  programId: PublicKey;
  /** `deployed`: executable account found; `missing`: no account at this address on the cluster. */
  state: "deployed" | "missing" | "not-executable" | "unreadable";
  /** Owner loader (BPF upgradeable loader, or another loader for non-upgradeable programs). */
  loader: PublicKey | null;
  /** True when the program can still be upgraded (upgradeable loader with an authority). */
  upgradeable: boolean | null;
  upgradeAuthority: PublicKey | null;
  lastDeploySlot: bigint | null;
}

/**
 * The fee recipients' verdict (audit round 3, F3), in the shape of the SDK's
 * `checkFeeRecipients` (next SDK release): every refusal and warning as
 * `"recipients[i].wallet: ..."`.
 */
export interface FeeRecipientsCheck {
  /** No refusal. */
  ok: boolean;
  refusals: string[];
  warnings: string[];
}

/** Whether the RPC endpoint serves the cluster this build was made for (genesis hash). */
export interface ClusterCheck {
  /** `match`: genesis hash is the expected cluster's; `unverified`: localnet (no fixed genesis); `error`: RPC unreachable. */
  state: "match" | "mismatch" | "unverified" | "error";
  genesisHash: string | null;
  detail: string;
}

export interface ChainBackend {
  readonly mode: "mock" | "live";

  // ------------------------------------------------- launch (SPEC §4.1) ---
  readonly fetchLaunch: typeof Sdk.fetchLaunch;
  readonly fetchLaunchByMint: typeof Sdk.fetchLaunchByMint;
  readonly listLaunches: typeof Sdk.listLaunches;
  readonly fetchCommit: typeof Sdk.fetchCommit;
  /** The launch's attestation (PQ v2): `launch` runs only with an attested one, inside its window, and anyone may send it then. */
  readonly fetchAttestation: typeof Sdk.fetchAttestation;
  /** What every commit naming one PQ vault as its token owner committed together (held to the per-wallet cap). */
  readonly fetchPayoutVault: typeof Sdk.fetchPayoutVault;
  readonly buildCreateLaunchTx: typeof Sdk.buildCreateLaunchTx;
  readonly buildLaunchTx: typeof Sdk.buildLaunchTx;
  readonly buildCommitTx: typeof Sdk.buildCommitTx;
  readonly buildExecuteBatchTx: typeof Sdk.buildExecuteBatchTx;
  readonly buildClaimTx: typeof Sdk.buildClaimTx;
  readonly buildClaimFeesTx: typeof Sdk.buildClaimFeesTx;
  readonly buildClaimLpFeesTx: typeof Sdk.buildClaimLpFeesTx;
  readonly buildDistributeTx: typeof Sdk.buildDistributeTx;
  readonly buildSwapTx: typeof Sdk.buildSwapTx;
  /**
   * Fee recipients as `distribute` pays them (the wSOL associated token
   * account of each wallet), checked against the chain before
   * `create_launch` (audit round 3, F3): refused are a PQ vault of another
   * mint than wSOL (a vault only ever moves its own mint, so its share would
   * be lost for good), any other account of the vault program, token
   * accounts and mints, programs and off-curve addresses with no account;
   * an account of another program is a warning. `buildCreateLaunchTx`
   * refuses the same recipients; a wizard checks them as they are entered.
   */
  readonly checkFeeRecipients: (conn: Connection, recipients: readonly Pick<Sdk.FeeRecipient, "wallet">[]) => Promise<FeeRecipientsCheck>;

  // ------------------------------- the launch flow (PQ v2, on-chain metadata) ---
  // planLaunch -> create_launch (the wallet; finalized) -> fund a throwaway payer (the wallet) -> publish_metadata and
  // attest_launch from that payer (the identity signs) -> launch inside the window (anyone) -> sweep the payer.
  readonly buildPlannedCreateLaunchTx: typeof Sdk.buildPlannedCreateLaunchTx;
  /** What the throwaway payer needs for `publish_metadata` and `attest_launch` (rents read from the cluster). */
  readonly throwawayPayerFunding: typeof Sdk.throwawayPayerFunding;
  readonly buildFundThrowawayPayerTx: typeof Sdk.buildFundThrowawayPayerTx;
  /** Signed v1 bytes from the throwaway payer, or `already-published` (publishing is idempotent). */
  readonly buildPlannedPublishTx: typeof Sdk.buildPlannedPublishTx;
  /** Refuses an underfunded payer before sending (`PublishPayerFundingError`). */
  readonly sendPublishMetadataTx: typeof Sdk.sendPublishMetadataTx;
  /** Until the record is visible at a commitment (default finalized: the identity signs only a final record). */
  readonly waitForTokenMeta: typeof Sdk.waitForTokenMeta;
  /**
   * The identity signs the plan's message at its next leaf (reserved in the leaf ledger first), after every refusal
   * of `buildAttestLaunchTx`: a launch or record that is not final, a window that cannot be used (60 s must be left
   * when it lands), another message's attestation whose window has not passed (audit round 3 F1: a passed one is
   * replaced), and a new leaf after two burn-only landings (`AttestRetryLimitError`).
   */
  readonly buildPlannedAttestTx: typeof Sdk.buildPlannedAttestTx;
  /** Sends, sends the SAME signature again after a ConstraintSeeds refusal, and reports attested / burned / pending. */
  readonly sendAttestLaunchTx: typeof Sdk.sendAttestLaunchTx;
  readonly confirmAttestation: typeof Sdk.confirmAttestation;
  /**
   * SDK 0.9.0: earlier signatures of a launch that may still land (`PendingAttestationError`), landed or confirmed from
   * the accounts with their recorded bytes (never a new signature); one whose leaf already shows as used is only
   * confirmed (audit 4, ID-F4).
   */
  readonly landOrBurnPending: typeof Sdk.landOrBurnPending;
  /** What is left on the throwaway payer, back to the creator (null when nothing is left above the fee). */
  readonly buildSweepPayerTx: typeof Sdk.buildSweepPayerTx;
  readonly getLaunchFlowStatus: typeof Sdk.getLaunchFlowStatus;
  /** Before launch: the attestation re-verified from live accounts, with the record it signed (show the record only when verified). */
  readonly verifyAttestation: typeof Sdk.verifyAttestation;
  /** The record a launch's attestation signed, resolved only through `Attestation.metadata_hash`. */
  readonly fetchTokenMetaForLaunch: typeof Sdk.fetchTokenMetaForLaunch;
  /** A mint's record, resolved only through its certificate's `metadata`. */
  readonly fetchTokenMetaForMint: typeof Sdk.fetchTokenMetaForMint;
  /** `getMinimumBalanceForRentExemption(size)`; a fee payer must end every transaction at 0 or at least `size = 0`'s. */
  readonly rentExemptLamports: typeof Sdk.rentExemptLamports;
  /**
   * What `launch` takes from whoever pays it: the rent of the accounts it creates (the mint at the size the record
   * gives it, the pool and its vaults, the Launch Guard's policy and account list, the certificate) and the fees of
   * its two signatures. The app funds its throwaway payer for it, so the launch opens by itself at its time.
   */
  readonly launchPayerLamports: (conn: Connection, metadata: Sdk.TokenMetaInput) => Promise<bigint>;

  // ------------------------------------------------- verify (SPEC §4.1) ---
  readonly verifyLaunch: typeof Sdk.verifyLaunch;
  /**
   * The mint's QSL-1 verdict (docs/standard/QSL-1.md §7): its level, or "candidate" while Noised's programs can still
   * be upgraded or the endpoint is not mainnet-beta (no level is awarded then), with every check in plain words. Live:
   * the SDK's `checkQsl1` and `qslBadge`; the simulated chain: its verification report mapped onto the standard.
   */
  readonly checkQsl1: (conn: Connection, mint: PublicKey) => Promise<QslVerdict>;

  // ----------------------------------------------------- pq (SPEC §4.1) ---
  /** `open_vault`'s refusals and warnings; the live backend adds the Launch Guard's wallet-to-wallet pause. */
  readonly checkVaultMint: typeof Sdk.checkVaultMint;
  readonly buildOpenVaultTx: typeof Sdk.buildOpenVaultTx;
  /** Into the vault's token account (wSOL: a SOL transfer + SyncNative). */
  readonly buildDepositTx: typeof Sdk.buildDepositTx;
  /** Signed v1 bytes around a STORED signature: rebuilding never signs with a vault key. */
  readonly buildWithdrawTx: typeof Sdk.buildWithdrawTx;
  /** Withdraw + release if the release passes simulation, else the withdrawal alone with the same signature. */
  readonly buildWithdrawTxWithFallback: typeof Sdk.buildWithdrawTxWithFallback;
  readonly buildReleaseTx: typeof Sdk.buildReleaseTx;
  readonly buildReleaseToTx: typeof Sdk.buildReleaseToTx;
  readonly fetchVault: typeof Sdk.fetchVault;
  readonly fetchPayout: typeof Sdk.fetchPayout;
  readonly listPayouts: typeof Sdk.listPayouts;
  /**
   * Refusals block signing; recipient warnings, token warnings and the
   * off-curve confirmation each need their own confirmation. The live
   * backend adds the Launch Guard's payout delays to the token warnings.
   */
  readonly checkRecipient: typeof Sdk.checkRecipient;
  /**
   * A withdrawal the vault's current key already signed (history, failed
   * transactions included): re-broadcast it, never sign again. Never sign
   * while the search is incomplete: continue it (`continueFrom`).
   */
  readonly findPendingWithdrawal: typeof Sdk.findPendingWithdrawal;
  /**
   * The only way the app signs a withdrawal: the vault-key ledger and the
   * user's recipient confirmation are required; it re-broadcasts what the
   * ledger or the chain already holds instead of signing again.
   */
  readonly prepareWithdrawal: typeof Sdk.prepareWithdrawal;
  readonly scanVaults: typeof Sdk.scanVaults;
  readonly buildFundFeePayerTx: typeof Sdk.buildFundFeePayerTx;
  readonly buildRefundFeePayerTx: typeof Sdk.buildRefundFeePayerTx;

  // ------------------------------------------------- shield (SPEC §4.1) ---
  readonly fetchShield: typeof Sdk.fetchShield;
  readonly buildCreateShieldTx: typeof Sdk.buildCreateShieldTx;
  readonly buildWrapTx: typeof Sdk.buildWrapTx;
  readonly buildUnwrapTx: typeof Sdk.buildUnwrapTx;

  // ---------------------------------------------------- rpc (SPEC §4.1) ---
  readonly getSolBalance: typeof Sdk.getSolBalance;
  readonly getTokenBalance: typeof Sdk.getTokenBalance;
  readonly getTokenSupply: typeof Sdk.getTokenSupply;
  /** Simulates without signatures; program error codes are named from the IDLs, other failures get plain words. */
  readonly simulateAndExplain: typeof Sdk.simulateAndExplain;
  /** Sends signed bytes and waits for confirmation; failures are explained like simulation failures. */
  readonly sendAndConfirm: typeof Sdk.sendAndConfirm;

  // ------------------------------------------------------------ app ---
  /** Decimals, supply, owner program and display labels of a mint; null if the account is not a mint. */
  readonly getMintInfo: (conn: Connection, mint: PublicKey) => Promise<MintInfo | null>;
  /** Compares the endpoint's genesis hash with the cluster this build targets. */
  readonly checkCluster: (conn: Connection, expected: Sdk.Cluster) => Promise<ClusterCheck>;
  /** Deployment status of the Noised programs and the third-party programs they depend on. */
  readonly programStatuses: (conn: Connection) => Promise<ProgramStatus[]>;
  /**
   * Whether the launchpad's one-time setup has run on this cluster: its `Protocol` account exists (owned by the
   * launchpad, at `["protocol"]`). Until then `create_launch` fails, so the app offers no launch. Throws when the
   * account cannot be read.
   */
  readonly protocolInitialized: (conn: Connection) => Promise<boolean>;
  /** The cluster's Clock sysvar time (what the programs compare windows against); null if unknown. */
  readonly chainUnixTime: (conn: Connection) => Promise<number | null>;
  /** Calls `onChange` whenever chain state the app shows may have changed. Returns an unsubscribe function. */
  readonly subscribeToChainChanges: (onChange: () => void) => () => void;
  /** Tell subscribers that a transaction confirmed. */
  readonly notifyChainChanged: () => void;
  /** Mock only: mints that exercise every branch of the vault's mint policy (empty in live builds). */
  readonly demoMints: () => MintInfo[];
  /** Mock only: demo balances for an account (no-op in live builds). */
  readonly fundDemoWallet: (owner: PublicKey) => void;
  /** Mock only: discard the simulated chain (throws in live builds). */
  readonly resetDemoState: () => void;
  /** Mock only: the quantum key of a simulated passkey, deterministic per credential id (throws in live builds). */
  readonly demoPasskeyMaster: (rpId: string, credentialId: Uint8Array) => Sdk.PqMaster;

  // ------------------------------------------------- programmable (PROGRAMMABLE_V1) ---
  /** Launch rules and Autopilot: the simulated chain, or the SDK 0.7.0 builders against the P1c programs (./programmableLive.ts). */
  readonly programmable: ProgrammableBackend;
}

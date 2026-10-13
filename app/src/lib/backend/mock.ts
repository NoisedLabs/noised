/**
 * MOCK backend: compiled into the bundle only when the app is built or served
 * with VITE_NOISED_MOCK=1 (vite.config.ts aliases `#noised-backend` here).
 *
 * Every read and transaction runs against a simulated chain in this browser
 * (src/lib/mock); nothing is sent to any RPC endpoint and no wallet is ever
 * asked to sign. Keys, messages, LM-OTS signatures, instruction data and the
 * v1 wire format are the SDK's real ones.
 */
import { KNOWN_ACCOUNTS, PROGRAM_IDS, type Cluster } from "@noisedlabs/sdk";
import type { Connection } from "@solana/web3.js";

import {
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
} from "../mock/launch";
import { programmableMock } from "../mock/programmable";
import {
  buildFundThrowawayPayerTx,
  buildPlannedAttestTx,
  buildPlannedCreateLaunchTx,
  buildPlannedPublishTx,
  buildSweepPayerTx,
  confirmAttestation,
  fetchTokenMetaForLaunch,
  landOrBurnPending,
  fetchTokenMetaForMint,
  getLaunchFlowStatus,
  launchPayerLamports,
  rentExemptLamports,
  sendAttestLaunchTx,
  sendPublishMetadataTx,
  throwawayPayerFunding,
  verifyAttestation,
  waitForTokenMeta,
} from "../mock/launchFlow";
import { demoPasskeyMaster } from "../mock/passkey";
import { demoMints, fundDemoWallet, getMintInfo, getSolBalance, getTokenBalance, getTokenSupply } from "../mock/rpc";
import { buildCreateShieldTx, buildUnwrapTx, buildWrapTx, fetchShield } from "../mock/shield";
import { send, simulate } from "../mock/sim";
import { mockEvents, nowSecs, persist, resetState } from "../mock/store";
import {
  buildDepositTx,
  buildFundFeePayerTx,
  buildOpenVaultTx,
  buildRefundFeePayerTx,
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
} from "../mock/vault";
import { mockQslProgrammable } from "../mock/qslProgrammable";
import { verifyLaunch } from "../mock/verify";
import { qslFromReport } from "../qsl";
import { GENESIS_HASHES } from "./genesis";
import type { ChainBackend, ClusterCheck, ProgramStatus } from "./types";

const SIMULATED: readonly { label: string; id: ProgramStatus["programId"] }[] = [
  { label: "Noised launchpad", id: PROGRAM_IDS.launchpad },
  { label: "Noised Launch Guard hook", id: PROGRAM_IDS.hook },
  { label: "Noised PQ vault", id: PROGRAM_IDS.vault },
  { label: "Noised shield", id: PROGRAM_IDS.shield },
  { label: "Meteora DBC", id: PROGRAM_IDS.dbc },
  { label: "Meteora DAMM v2", id: PROGRAM_IDS.dammV2 },
  { label: "Token-2022", id: KNOWN_ACCOUNTS.token2022 },
  { label: "SPL Token", id: KNOWN_ACCOUNTS.splToken },
];

export const backend: ChainBackend = {
  mode: "mock",

  fetchLaunch,
  fetchLaunchByMint,
  listLaunches,
  fetchCommit,
  fetchAttestation,
  fetchPayoutVault,
  buildCreateLaunchTx,
  buildLaunchTx,
  buildCommitTx,
  buildExecuteBatchTx,
  buildClaimTx,
  buildClaimFeesTx,
  buildClaimLpFeesTx,
  buildDistributeTx,
  buildSwapTx,
  checkFeeRecipients,

  buildPlannedCreateLaunchTx,
  throwawayPayerFunding,
  buildFundThrowawayPayerTx,
  buildPlannedPublishTx,
  sendPublishMetadataTx,
  waitForTokenMeta,
  buildPlannedAttestTx,
  sendAttestLaunchTx,
  confirmAttestation,
  landOrBurnPending,
  buildSweepPayerTx,
  getLaunchFlowStatus,
  verifyAttestation,
  fetchTokenMetaForLaunch,
  fetchTokenMetaForMint,
  rentExemptLamports,
  launchPayerLamports,

  verifyLaunch,
  // The simulated chain stands for devnet, where Noised's programs can still be upgraded: candidates, never a level.
  // The verdict from the simulated chain's report, with the creator's rules and automation as the SDK describes them.
  checkQsl1: async (conn, mint) => {
    const report = await verifyLaunch(conn, mint);
    return qslFromReport(report, "devnet", await mockQslProgrammable(conn, report));
  },

  checkVaultMint,
  buildOpenVaultTx,
  buildDepositTx,
  buildWithdrawTx,
  buildWithdrawTxWithFallback,
  buildReleaseTx,
  buildReleaseToTx,
  fetchVault,
  fetchPayout,
  listPayouts,
  checkRecipient,
  // The simulated chain keeps every landed withdraw, failed ones included, like a full-history RPC.
  findPendingWithdrawal,
  prepareWithdrawal,
  scanVaults,
  buildFundFeePayerTx,
  buildRefundFeePayerTx,

  fetchShield,
  buildCreateShieldTx,
  buildWrapTx,
  buildUnwrapTx,

  getSolBalance,
  getTokenBalance,
  getTokenSupply,
  simulateAndExplain: (_conn, tx) => simulate(tx),
  sendAndConfirm: (_conn, tx) => send(tx),

  getMintInfo,
  // The simulated chain IS the cluster this build targets (its genesis hash), like an endpoint that serves it;
  // a localnet build has no fixed genesis hash, so it stays unverified exactly as against a local validator.
  checkCluster: async (_conn: Connection, expected: Cluster): Promise<ClusterCheck> =>
    expected === "localnet"
      ? { state: "unverified", genesisHash: null, detail: "Demo mode: a simulated local cluster in this browser; no RPC endpoint is contacted." }
      : {
          state: "match",
          genesisHash: GENESIS_HASHES[expected],
          detail: `Demo mode: a simulated ${expected} chain in this browser (genesis ${GENESIS_HASHES[expected]}); no RPC endpoint is contacted.`,
        },
  programStatuses: async (): Promise<ProgramStatus[]> =>
    SIMULATED.map((p) => ({
      label: p.label,
      programId: p.id,
      state: "deployed",
      loader: KNOWN_ACCOUNTS.bpfLoaderUpgradeable,
      upgradeable: null,
      upgradeAuthority: null,
      lastDeploySlot: null,
    })),
  // The simulated deployment's protocol is initialized (lib/mock/fixtures.ts): launches are open in the demo.
  protocolInitialized: async () => true,
  chainUnixTime: async () => nowSecs(),
  subscribeToChainChanges: (onChange) => {
    const handler = (): void => onChange();
    mockEvents.addEventListener("change", handler);
    return () => mockEvents.removeEventListener("change", handler);
  },
  notifyChainChanged: () => persist(),
  demoMints,
  fundDemoWallet,
  resetDemoState: resetState,
  demoPasskeyMaster,
  programmable: programmableMock,
};

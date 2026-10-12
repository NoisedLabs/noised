/** The vault flow's chain access (src/lib/vaultFlow.ts), taken from the adapter: the live SDK or, in demo builds, the simulated chain. */
import {
  ADAPTER_MODE,
  buildWithdrawTx,
  buildWithdrawTxWithFallback,
  checkCluster,
  checkRecipient,
  fetchPayout,
  fetchVault,
  findPendingWithdrawal,
  prepareWithdrawal,
  simulateAndExplain,
} from "../../lib/noised";
import type { VaultChain } from "../../lib/vaultFlow";

export const VAULT_CHAIN: VaultChain = {
  mode: ADAPTER_MODE,
  checkCluster,
  fetchVault,
  fetchPayout,
  checkRecipient,
  findPendingWithdrawal,
  prepareWithdrawal,
  buildWithdrawTx,
  buildWithdrawTxWithFallback,
  simulateAndExplain,
};

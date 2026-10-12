/**
 * Genesis hashes of the public clusters. Both backends use them for the
 * cluster check (`checkCluster`): the live one compares the endpoint's hash,
 * the simulated chain reports the hash of the cluster it stands for.
 *
 * Mainnet and devnet are the SDK's own `GENESIS_HASHES`, the values its PQ
 * signers check before every signature (`assertCluster`), so the app's
 * wrong-network banner and the SDK's refusal can never disagree. (Until SDK
 * 0.5.1 the SDK's devnet hash was wrong and this file kept its own copy.)
 * Testnet is not a Noised cluster: it is listed only to name it when an
 * endpoint serves it. test/live-backend.test.ts pins all three values.
 */
import { GENESIS_HASHES as SDK_GENESIS_HASHES } from "@noisedlabs/sdk";

export const GENESIS_HASHES = {
  mainnet: SDK_GENESIS_HASHES.mainnet,
  devnet: SDK_GENESIS_HASHES.devnet,
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

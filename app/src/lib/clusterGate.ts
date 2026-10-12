/**
 * Whether the RPC endpoint is known to serve the cluster this build targets.
 * Every PQ vault signature and every broadcast requires it: a withdraw
 * message names no cluster, and the vault keys, the explorer links and the
 * trust anchors are all per cluster. Fails closed: the endpoint's genesis
 * hash must be the cluster's (`match`); `unverified` (no fixed genesis) is
 * accepted only by a localnet build; a check that failed, did not run yet or
 * found another cluster refuses. The simulated chain of a demo build reports
 * the genesis hash of the cluster it stands for, so the same rule applies.
 *
 * The SDK's PQ signers also check the genesis hash themselves
 * (`assertCluster`) and throw `ClusterMismatchError`: `clusterMismatchText`
 * says what that means in plain words.
 */
import { ClusterMismatchError, type Cluster, type ClusterCheck } from "./noised";

/** Why signing or broadcasting is refused with this cluster check, or null when it is allowed. */
export function clusterRefusal(check: ClusterCheck | null, cluster: Cluster, _mode: "mock" | "live"): string | null {
  if (check === null) return "The RPC endpoint's cluster has not been checked yet.";
  switch (check.state) {
    case "match":
      return null;
    case "unverified":
      if (cluster === "localnet") return null;
      return `The RPC endpoint's cluster could not be verified (${check.detail}); this ${cluster} build signs only against an endpoint whose genesis hash is ${cluster}'s.`;
    case "mismatch":
      return check.detail;
    case "error":
      return `The RPC endpoint's cluster could not be checked (${check.detail}).`;
  }
}

/** Plain words for the SDK's `ClusterMismatchError` (a PQ signer refused the endpoint), or null for any other error. */
export function clusterMismatchText(e: unknown): string | null {
  if (!(e instanceof ClusterMismatchError)) return null;
  const now = e.actual ?? (e.genesisHash === null ? "a network it could not identify" : "another network");
  return `This app signs for ${e.expected}, but the network connection is ${now}${e.genesisHash === null ? "" : ` (genesis ${e.genesisHash})`}. Nothing was signed. (${e.message})`;
}

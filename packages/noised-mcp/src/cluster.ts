/**
 * Which cluster the endpoint really serves, from its genesis hash (the SDK's
 * `assertCluster`): checked once at start and again before every build. A
 * "devnet" endpoint that actually serves mainnet is refused, and mainnet is
 * refused unless the operator opted in (NOISED_ALLOW_MAINNET=1).
 *
 * The endpoint's answers are untrusted: its error messages never reach a
 * message here (they stay in `cause`), and a genesis hash that is not a
 * base58 hash is refused rather than repeated.
 */
import { assertCluster, ClusterMismatchError, clusterOfGenesisHash } from "@noisedlabs/sdk";
import type { Connection } from "@solana/web3.js";

import type { ExpectedCluster } from "./config.js";

export interface ClusterInfo {
  /** The cluster the endpoint serves: mainnet / devnet by genesis hash, else localnet (any other hash). */
  cluster: ExpectedCluster;
  genesisHash: string;
}

const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Refuses (throws ClusterMismatchError) unless `conn` serves `expected`, and refuses mainnet without the opt-in. */
export async function checkCluster(conn: Connection, expected: ExpectedCluster, allowMainnet: boolean): Promise<ClusterInfo> {
  let genesisHash: string;
  try {
    genesisHash = await assertCluster(conn, expected, { allowLocalnet: expected === "localnet" });
  } catch (e) {
    // The SDK words it for signers ("refusing to sign: ...") and quotes the endpoint; this server never signs and
    // never repeats what the endpoint said.
    if (e instanceof ClusterMismatchError) {
      if (e.genesisHash === null || !HASH.test(e.genesisHash)) {
        throw withCause(new ClusterMismatchError(`wrong cluster: could not read a valid genesis hash from the endpoint to confirm it serves ${expected}`, e.expected, null), e);
      }
      const actual = clusterOfGenesisHash(e.genesisHash);
      throw withCause(new ClusterMismatchError(`wrong cluster: configured for ${expected}, but the endpoint serves ${actual ?? "another cluster"} (genesis ${e.genesisHash})`, e.expected, e.genesisHash), e);
    }
    throw withCause(new ClusterMismatchError(`wrong cluster: could not confirm that the endpoint serves ${expected}`, expected, null), e);
  }
  if (!HASH.test(genesisHash)) throw new ClusterMismatchError(`wrong cluster: the endpoint's genesis hash is not a valid hash (expected ${expected})`, expected, null);
  const actual = clusterOfGenesisHash(genesisHash) ?? "localnet";
  if (actual === "mainnet" && !allowMainnet) {
    throw new ClusterMismatchError("refusing: the endpoint serves mainnet and NOISED_ALLOW_MAINNET is not 1", expected, genesisHash);
  }
  return { cluster: actual, genesisHash };
}

function withCause<E extends Error>(e: E, cause: unknown): E {
  (e as { cause?: unknown }).cause = cause;
  return e;
}

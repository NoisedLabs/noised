/**
 * Which cluster an RPC endpoint serves, from its genesis hash.
 *
 * A post-quantum signature (a vault withdrawal, an identity attestation)
 * names program ids and accounts that exist at the same addresses on every
 * cluster, and nothing in it says which cluster it is for. A "devnet" run
 * whose endpoint is really mainnet, or a "mainnet" run against a devnet
 * endpoint where someone recreated the same accounts, therefore produces a
 * signature that is valid on mainnet, and a one-time key that signs twice is
 * forgeable. So every PQ signing entry point calls `assertCluster` before it
 * signs, with the cluster the keys were derived for, and refuses on any
 * mismatch. The caller's cluster label is never trusted on its own.
 */
import type { Connection } from "@solana/web3.js";

import { CLUSTERS, type Cluster } from "../constants.js";

/** Genesis hashes of the public clusters (`getGenesisHash`), as served by mainnet-beta and devnet (checked with `solana genesis-hash` on 2026-10-10). Any other hash is a local or private cluster. */
export const GENESIS_HASHES: Readonly<{ mainnet: string; devnet: string }> = Object.freeze({
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
});

/** `assertCluster` options. */
export interface AssertClusterOptions {
  /**
   * Accept `expected = "localnet"`: the endpoint's genesis hash must then be
   * neither mainnet's nor devnet's (a local validator or Surfpool has its own).
   * Without it, signing for localnet is refused, so a build or a setting that
   * says "localnet" by mistake can never sign.
   */
  allowLocalnet?: boolean | undefined;
}

/** The public cluster a genesis hash belongs to; null for any other hash (local or private cluster). */
export function clusterOfGenesisHash(hash: string): "mainnet" | "devnet" | null {
  if (hash === GENESIS_HASHES.mainnet) return "mainnet";
  if (hash === GENESIS_HASHES.devnet) return "devnet";
  return null;
}

/** `assertCluster` refused: the endpoint does not serve the cluster the keys are for (or could not tell). Nothing was signed. */
export class ClusterMismatchError extends Error {
  /** The cluster the caller said it signs for. */
  readonly expected: Cluster;
  /** The endpoint's genesis hash (null when it could not be read). */
  readonly genesisHash: string | null;
  /** The public cluster of that hash, or null (another cluster, or unknown). */
  readonly actual: "mainnet" | "devnet" | null;

  constructor(message: string, expected: Cluster, genesisHash: string | null) {
    super(message);
    this.name = "ClusterMismatchError";
    this.expected = expected;
    this.genesisHash = genesisHash;
    this.actual = genesisHash === null ? null : clusterOfGenesisHash(genesisHash);
  }
}

/**
 * Refuse (throw `ClusterMismatchError`) unless `conn` serves `expected`:
 * mainnet and devnet by their genesis hash; localnet only with
 * `opts.allowLocalnet`, and only when the hash is neither mainnet's nor
 * devnet's. Reads `getGenesisHash()` on every call (no cache: the check is
 * about this connection, now). Returns the genesis hash.
 *
 * Call it before every PQ signature, with the cluster the signing keys were
 * derived for. A failure to read the hash is a refusal too.
 */
export async function assertCluster(conn: Connection, expected: Cluster, opts: AssertClusterOptions = {}): Promise<string> {
  if (!Object.prototype.hasOwnProperty.call(CLUSTERS, expected)) throw new RangeError(`unknown cluster ${String(expected)}`);
  if (expected === "localnet" && opts.allowLocalnet !== true) {
    throw new ClusterMismatchError(
      "refusing to sign for localnet without allowLocalnet: a localnet label is accepted only when the caller explicitly opts into it",
      expected,
      null,
    );
  }
  let hash: unknown;
  try {
    hash = await conn.getGenesisHash();
  } catch (e) {
    throw new ClusterMismatchError(
      `refusing to sign: could not read the endpoint's genesis hash to confirm it serves ${expected} (${e instanceof Error ? e.message : String(e)})`,
      expected,
      null,
    );
  }
  if (typeof hash !== "string" || hash === "") throw new ClusterMismatchError(`refusing to sign: the endpoint returned no genesis hash (expected ${expected})`, expected, null);
  const actual = clusterOfGenesisHash(hash);
  if (expected === "localnet") {
    if (actual !== null) {
      throw new ClusterMismatchError(
        `refusing to sign: keys for localnet, but the endpoint serves ${actual} (genesis ${hash}); a signature made here would be valid on ${actual}`,
        expected,
        hash,
      );
    }
    return hash;
  }
  if (hash !== GENESIS_HASHES[expected]) {
    throw new ClusterMismatchError(
      `refusing to sign: keys for ${expected}, but the endpoint serves ${actual ?? "another cluster"} (genesis ${hash}, ${expected}'s is ${GENESIS_HASHES[expected]})`,
      expected,
      hash,
    );
  }
  return hash;
}

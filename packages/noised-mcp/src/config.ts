/**
 * Configuration, from environment variables only (an MCP client starts this
 * server as a subprocess and passes them):
 *
 * - NOISED_CLUSTER        devnet (default) | localnet | mainnet: the cluster the
 *                          operator expects. The endpoint's genesis hash must match.
 * - NOISED_RPC_URL        the RPC endpoint (default: the cluster's public one;
 *                          http://127.0.0.1:8899 for localnet). https, except
 *                          that localnet also accepts plain http to this
 *                          machine only (127.0.0.1, [::1] or localhost).
 * - NOISED_ALLOW_MAINNET  must be exactly "1" to serve mainnet. Without it the
 *                          server refuses to start against mainnet, whatever
 *                          NOISED_CLUSTER says.
 * - NOISED_COMMITMENT     confirmed (default) | finalized: reads and simulations.
 *
 * The names before the rename to Noised (PHALANX_CLUSTER, PHALANX_RPC_URL,
 * PHALANX_ALLOW_MAINNET, PHALANX_COMMITMENT) are still read when the new ones
 * are unset, for one release.
 *
 * There is deliberately no setting for a private key: the server never signs.
 */
import type { Commitment } from "@solana/web3.js";

export type ExpectedCluster = "mainnet" | "devnet" | "localnet";

export interface ServerConfig {
  cluster: ExpectedCluster;
  rpcUrl: string;
  allowMainnet: boolean;
  commitment: Extract<Commitment, "confirmed" | "finalized">;
}

/** A configuration the server refuses to start with. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Hosts plain http may go to (a local validator): `URL.hostname` spells IPv6 in brackets. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

const DEFAULT_RPC: Record<ExpectedCluster, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/** Reads and checks the configuration. Throws ConfigError on anything unclear (fail closed). */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const setting = (name: `NOISED_${string}`): string | undefined => env[name] ?? env[name.replace("NOISED_", "PHALANX_")];
  const rawCluster = (setting("NOISED_CLUSTER") ?? "devnet").trim().toLowerCase();
  const cluster = rawCluster === "mainnet-beta" ? "mainnet" : rawCluster;
  if (cluster !== "mainnet" && cluster !== "devnet" && cluster !== "localnet") {
    throw new ConfigError(`NOISED_CLUSTER must be devnet, localnet or mainnet (got "${rawCluster}")`);
  }
  const allowRaw = setting("NOISED_ALLOW_MAINNET");
  if (allowRaw !== undefined && allowRaw !== "" && allowRaw !== "0" && allowRaw !== "1") {
    throw new ConfigError('NOISED_ALLOW_MAINNET must be "1" (allow) or unset');
  }
  const allowMainnet = allowRaw === "1";
  if (cluster === "mainnet" && !allowMainnet) {
    throw new ConfigError("refusing to start on mainnet: set NOISED_ALLOW_MAINNET=1 to serve mainnet (the server still never signs)");
  }
  const rpcUrl = (setting("NOISED_RPC_URL") ?? "").trim() || DEFAULT_RPC[cluster];
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new ConfigError("NOISED_RPC_URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("NOISED_RPC_URL must be an http(s) URL");
  if (cluster !== "localnet" && url.protocol !== "https:") throw new ConfigError(`NOISED_RPC_URL must use https for ${cluster}`);
  // Plain http only to this machine: anyone on the path of an http connection to another host could answer for it.
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ConfigError("NOISED_RPC_URL: plain http is accepted only for a validator on this machine (127.0.0.1, [::1] or localhost); use https for any other host");
  }
  const commitment = (setting("NOISED_COMMITMENT") ?? "confirmed").trim();
  if (commitment !== "confirmed" && commitment !== "finalized") throw new ConfigError('NOISED_COMMITMENT must be "confirmed" or "finalized"');
  return { cluster, rpcUrl, allowMainnet, commitment };
}

/** The RPC URL without credentials or query (API keys often live there): safe to print. */
export function redactedRpcUrl(rpcUrl: string): string {
  try {
    const u = new URL(rpcUrl);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "(invalid URL)";
  }
}

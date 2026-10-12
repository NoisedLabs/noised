#!/usr/bin/env node
/**
 * noised-mcp: the Noised MCP server over stdio.
 *
 * Start-up refuses (exit code 2) when the configuration is unclear, when the
 * endpoint's genesis hash is not the configured cluster's, or when it serves
 * mainnet without NOISED_ALLOW_MAINNET=1. Logs go to stderr only (stdout
 * carries the protocol).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection } from "@solana/web3.js";

import { checkCluster } from "./cluster.js";
import { loadConfig, redactedRpcUrl } from "./config.js";
import { createNoisedServer, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const conn = new Connection(config.rpcUrl, { commitment: config.commitment, disableRetryOnRateLimit: false });
  const cluster = await checkCluster(conn, config.cluster, config.allowMainnet);
  const server = createNoisedServer({ conn, config, cluster });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`noised-mcp ${SERVER_VERSION}: serving ${cluster.cluster} (genesis ${cluster.genesisHash}) via ${redactedRpcUrl(config.rpcUrl)}; read, simulate and build-only (never signs)\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`noised-mcp: refusing to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
});

/**
 * A second, independent RPC connection for the SDK's cross-checks (SDK 0.9.0, audit 4): before the quantum key signs
 * a time, the network's clock is compared on two connections, and before the person may confirm that a key was used
 * elsewhere, its on-chain record is read again on the second one (a single lying RPC could show anything).
 *
 * It is only ever another of this build's own endpoints (RPC_ENDPOINTS: exactly the hosts the CSP's connect-src
 * allows), never the one selected, and null when the build lists only one (or in the demo: the simulated chain has no
 * second network). The one place outside the wallet adapter's provider that makes a Connection
 * (test/ui-boundaries.test.ts).
 */
import { Connection } from "@solana/web3.js";

import { ADAPTER_MODE } from "../lib/noised";
import { RPC_ENDPOINTS } from "./settings";

const made = new Map<string, Connection>();

/** A connection to another endpoint of this build than `selectedUrl` (null: there is none). */
export function secondConnection(selectedUrl: string): Connection | null {
  if (ADAPTER_MODE === "mock") return null;
  const other = RPC_ENDPOINTS.find((e) => e.url !== selectedUrl);
  if (other === undefined) return null;
  let c = made.get(other.url);
  if (c === undefined) {
    c = new Connection(other.url, { commitment: "confirmed" });
    made.set(other.url, c);
  }
  return c;
}

/** The label of that endpoint, for "read again on …" (null: none). */
export function secondEndpointLabel(selectedUrl: string): string | null {
  if (ADAPTER_MODE === "mock") return null;
  return RPC_ENDPOINTS.find((e) => e.url !== selectedUrl)?.label ?? null;
}

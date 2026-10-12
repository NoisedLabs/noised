/** Content addresses of rule sets and graphs (spec §1.2, §1.3). */
import { sha256 } from "@noble/hashes/sha2.js";

import { PXG1, PXR1 } from "./constants.js";
import { toHex, utf8 } from "./bytes.js";

function tagged(tag: string, bytes: Uint8Array): Uint8Array {
  const t = utf8(tag);
  const msg = new Uint8Array(t.length + bytes.length);
  msg.set(t, 0);
  msg.set(bytes, t.length);
  return sha256(msg);
}

/** The all-zero hash: "no custom rules". */
export const ZERO_HASH: Uint8Array = new Uint8Array(32);

/**
 * rules_hash = SHA256("PHX-RULES-V1" || PXR1 bytes). `null` or empty bytes
 * (no custom rules) give the all-zero hash, as the launchpad expects.
 */
export function rulesHash(bytes: Uint8Array | null | undefined): Uint8Array {
  if (!bytes || bytes.length === 0) return new Uint8Array(32);
  return tagged(PXR1.HASH_TAG, bytes);
}

/** graph_hash = SHA256("PHX-GRAPH-V1" || PXG1 bytes). */
export function graphHash(bytes: Uint8Array): Uint8Array {
  return tagged(PXG1.HASH_TAG, bytes);
}

export const rulesHashHex = (bytes: Uint8Array | null | undefined): string => toHex(rulesHash(bytes));
export const graphHashHex = (bytes: Uint8Array): string => toHex(graphHash(bytes));

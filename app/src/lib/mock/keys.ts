/** MOCK: deterministic demo keys (no private key is ever used). */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, type PublicKey } from "@solana/web3.js";

import { utf8 } from "./bytes";

const cache = new Map<string, PublicKey>();

/** A stable on-curve public key for a demo label. */
export function demoKey(label: string): PublicKey {
  const hit = cache.get(label);
  if (hit) return hit;
  // demo derivation tag, kept from the original name: changing it changes every simulated address
  const key = Keypair.fromSeed(sha256(utf8(`phalanx-demo/${label}`))).publicKey;
  cache.set(label, key);
  return key;
}

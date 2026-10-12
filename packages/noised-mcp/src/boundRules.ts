/**
 * A launch's bound rules, read with the SDK's readers as the SDK prescribes
 * (never by searching for records): a live launch's rules hash is in its
 * certificate; before launch, in its attestation. The record
 * `["rules", launch, hash]` holds the bytes, and the Launch Guard policy
 * holds the bytes it actually enforces.
 */
import { fetchAttestation, fetchCertificate, fetchHookPolicy, fetchLaunchRules, type LaunchAccount } from "@noisedlabs/sdk";
import type { Connection, PublicKey } from "@solana/web3.js";

export interface BoundRules {
  /** Where the rules hash was read: the certificate (live) or the attestation (before launch); null: neither exists. */
  boundIn: "certificate" | "attestation" | null;
  /** The bound rules hash; null when none is bound (all-zero or no attestation / certificate). */
  rulesHash: Uint8Array | null;
  /** The rules record the hash names (null: none bound, or not published). */
  record: { address: PublicKey; bytes: Uint8Array } | null;
  /** The bytes the Launch Guard enforces (live launches; empty: none), null when not read. */
  enforced: Uint8Array | null;
}

export type BoundRulesReader = (conn: Connection, launch: LaunchAccount) => Promise<BoundRules>;

const allZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

/** The default reader: the certificate or attestation, the rules record it names, and the Launch Guard policy. */
export const readBoundRulesOnChain: BoundRulesReader = async (conn, l) => {
  let boundIn: BoundRules["boundIn"] = null;
  let hash: Uint8Array | null = null;
  if (l.status === "live") {
    const cert = await fetchCertificate(conn, l.baseMint);
    if (cert !== null) {
      boundIn = "certificate";
      hash = cert.rulesHash;
    }
  } else {
    const att = await fetchAttestation(conn, l.publicKey);
    if (att !== null) {
      boundIn = "attestation";
      hash = att.rulesHash;
    }
  }
  const rulesHash = hash === null || allZero(hash) ? null : hash;
  const rec = rulesHash === null ? null : await fetchLaunchRules(conn, l.publicKey, rulesHash);
  const policy = l.status === "live" ? await fetchHookPolicy(conn, l.baseMint) : null;
  return { boundIn, rulesHash, record: rec === null ? null : { address: rec.publicKey, bytes: rec.bytes }, enforced: policy === null ? null : policy.rules };
};

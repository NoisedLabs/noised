/**
 * MOCK passkey for the quantum key (lib/pqKey.ts) in demo builds: no
 * authenticator is asked; the PRF output is computed from the demo
 * credential's id, so the same demo passkey always unlocks the same key. It
 * runs the SDK's real checks and derivation on a synthetic assertion, but
 * protects nothing, and the UI says so. Only the mock backend imports this
 * module, so a live bundle never contains it (build/output-checks.ts).
 */
import { pqIdentity, type PqMaster } from "@noisedlabs/sdk";
import { sha256 } from "@noble/hashes/sha2.js";

/** The demo passkey's PRF output: derived from its credential id (it protects nothing). */
function demoPrf(credentialId: Uint8Array): Uint8Array {
  // demo derivation tag, kept from the original name (the simulated passkey's identity)
  return sha256(new TextEncoder().encode(`phalanx-demo/passkey-prf/${Array.from(credentialId, (b) => b.toString(16).padStart(2, "0")).join("")}`));
}

/** A synthetic assertion for the demo passkey: authenticator data with this RP ID's hash and the UP and UV flags, and the PRF result. */
function demoAssertion(rpId: string, credentialId: Uint8Array): pqIdentity.PasskeyAssertionLike {
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(sha256(new TextEncoder().encode(rpId)), 0);
  authenticatorData[32] = 0x01 | 0x04;
  return { authenticatorData, clientExtensionResults: { prf: { results: { first: demoPrf(credentialId) } } } };
}

/**
 * The key of a demo passkey: the SDK's real checks (RP ID hash, presence and verification flags, PRF length) and
 * derivation run on the synthetic assertion, so the same demo passkey always unlocks the same key.
 */
export function demoPasskeyMaster(rpId: string, credentialId: Uint8Array): PqMaster {
  return pqIdentity.deriveMasterFromPasskeyAssertion(demoAssertion(rpId, credentialId), { rpId });
}

/**
 * MOCK: a launch's creator rules (PXR1) as its attestation signed them (attestation v3), read from the simulated chain
 * the way the SDK reads them (`AttestedRules`, and `VerifiedRules` after launch).
 */
import { PROGRAM_IDS, rulesAccountFor, type AttestedRules, type LaunchRulesAccount } from "@noisedlabs/sdk";
import { explainRules } from "@noisedlabs/sdk/programmable";
import { PublicKey } from "@solana/web3.js";

import { toHex } from "./bytes";
import { publishedRules } from "./common";

export const isZeroHash = (h: Uint8Array): boolean => h.every((b) => b === 0);

/** The rules an attestation signed: their hash, record address, bytes and plain English ("No launch rules" without). */
export function attestedRulesOf(launch: PublicKey, rulesHash: Uint8Array, guardSecs: number, tokenDecimals: number): { rules: AttestedRules; record: LaunchRulesAccount | null } {
  if (isZeroHash(rulesHash)) return { rules: { hash: toHex(rulesHash), address: null, bytes: new Uint8Array(0), explanation: ["No launch rules: only the built-in Launch Guard applies."] }, record: null };
  const address = rulesAccountFor(launch, rulesHash);
  const bytes = publishedRules(launch.toBase58(), rulesHash);
  let explanation: string[] = [];
  if (bytes !== null) {
    try {
      explanation = explainRules(bytes, { guardSecs, tokenDecimals });
    } catch {
      explanation = [];
    }
  }
  const [pda, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("rules"), launch.toBytes(), rulesHash], PROGRAM_IDS.launchpad);
  return {
    rules: { hash: toHex(rulesHash), address, bytes: bytes ?? new Uint8Array(0), explanation },
    record: bytes === null ? null : { publicKey: pda, version: 1, bump, launch, rulesHash: Uint8Array.from(rulesHash), bytes },
  };
}

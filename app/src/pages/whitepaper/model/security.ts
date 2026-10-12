/**
 * Generic attack costs in bits (log2 of the expected work) for figure 1, computed from the parameters rather than
 * typed in:
 *   Pollard rho on a prime-order group of order l: sqrt(pi l / 4) group operations.
 *   Shor: polynomial time on a cryptographically relevant quantum computer (drawn as 0 bits).
 *   Exhaustive preimage search on n bits: 2^n classically; Grover: (pi / 4) 2^(n/2) iterations.
 * LM-OTS and LMS with n = 32: a forgery from at most one signature per one-time key needs a digest that equals the
 * signed digit vector (lemma 1) or a second preimage of a tweaked SHA-256 node, both 256-bit searches.
 */

/** Ed25519 base-point order: 2^252 + 27742317777372353535851937790883648493. */
export const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;
/** secp256k1 group order. */
export const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function log2Big(x: bigint): number {
  const bits = x.toString(2).length;
  const shift = Math.max(0, bits - 53);
  return Math.log2(Number(x >> BigInt(shift))) + shift;
}

/** log2 of Pollard rho's expected group operations, sqrt(pi l / 4). */
export function rhoBits(order: bigint): number {
  return 0.5 * (Math.log2(Math.PI / 4) + log2Big(order));
}

/** log2 of Grover iterations for an n-bit search, (pi / 4) 2^(n/2). */
export function groverBits(n: number): number {
  return n / 2 + Math.log2(Math.PI / 4);
}

export interface BitsRow {
  key: string;
  label: string;
  sub: string;
  classical: number;
  quantum: number;
  quantumNote: string;
}

export function securityRows(): BitsRow[] {
  return [
    { key: "ed25519", label: "Ed25519", sub: "every Solana wallet", classical: rhoBits(ED25519_L), quantum: 0, quantumNote: "Shor: polynomial time" },
    { key: "secp", label: "secp256k1", sub: "Bitcoin, Ethereum", classical: rhoBits(SECP256K1_N), quantum: 0, quantumNote: "Shor: polynomial time" },
    { key: "sha", label: "SHA-256 preimage", sub: "PDAs, hash chains", classical: 256, quantum: groverBits(256), quantumNote: "Grover: square root" },
    { key: "lmots", label: "LM-OTS (N32, W4)", sub: "PQ vault keys", classical: 256, quantum: groverBits(256), quantumNote: "Grover on the 256-bit digest" },
    { key: "lms", label: "LMS (M32, H10)", sub: "creator identities", classical: 256, quantum: groverBits(256), quantumNote: "Grover on tweaked SHA-256" },
  ];
}

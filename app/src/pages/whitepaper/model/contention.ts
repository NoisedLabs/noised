/**
 * Write-lock contention cost model (whitepaper section 7). To keep honest commits (or execute_batch) out of every
 * block, an attacker must fill the per-account write budget of the Launch account in every block of the window, and
 * outbid the honest transactions' compute-unit price for all of it.
 *
 * Parameters (sources in the paper):
 *   B     = 24,000,000 CU   Agave 4.3.0 MAX_WRITABLE_ACCOUNT_UNITS (cost-model/src/block_cost_limits.rs)
 *   Cmax  = 1,400,000 CU    largest compute budget of one transaction (FACTS #5)
 *   f0    = 5,000 lamports  base fee per signature
 *   slot  = 0.4 s           nominal slot time
 * A block packer charges the attacker's compute-unit price on the CU it requests, so filling B at price pi
 * (micro-lamports per CU) costs about B * pi / 1e6 lamports per block, plus ceil(B / Cmax) base fees.
 */

export const B_WRITE = 24_000_000;
export const C_MAX = 1_400_000;
export const BASE_FEE = 5_000;
export const SLOT_SECONDS = 0.4;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Transactions per block needed to fill the account's budget. */
export const TX_PER_BLOCK = Math.ceil(B_WRITE / C_MAX);

/** Attacker lamports per block when honest transactions pay `pi` micro-lamports per CU (it pays pi + 1). */
export function attackerPerBlock(pi: number): number {
  return TX_PER_BLOCK * BASE_FEE + Math.ceil((B_WRITE * (pi + 1)) / 1e6);
}

/** Attacker SOL to keep the account full for `seconds`. */
export function attackerSol(seconds: number, pi: number): number {
  return ((seconds / SLOT_SECONDS) * attackerPerBlock(pi)) / LAMPORTS_PER_SOL;
}

/** What one honest commit pays at price `pi` with a tight compute limit (default 50,000 CU). */
export function honestSol(pi: number, cuLimit = 50_000): number {
  return (BASE_FEE + Math.ceil((cuLimit * pi) / 1e6)) / LAMPORTS_PER_SOL;
}

/** Honest priority levels drawn in the figure (micro-lamports per CU). */
export const PRICE_LEVELS: readonly { pi: number; label: string }[] = [
  { pi: 0, label: "honest pays no priority fee" },
  { pi: 10_000, label: "10k µlamports/CU" },
  { pi: 100_000, label: "100k µlamports/CU" },
  { pi: 1_000_000, label: "1M µlamports/CU" },
];

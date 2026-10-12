/**
 * Display-only data shown next to SDK values: human program names,
 * certificate check labels, and plain-words explanations of runtime and RPC
 * failures that are not program error codes (those come from the IDLs via
 * the SDK's `simulateAndExplain`). Pure; no chain access.
 */
import { CERTIFICATE_ALL_CHECKS, CERTIFICATE_CHECKS, programLabel as sdkProgramName } from "@noisedlabs/sdk";
import type { PublicKey } from "@solana/web3.js";

/** Display names of the programs a Noised transaction may invoke, keyed by the SDK's program names. */
const PROGRAM_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  noised_launchpad: "Noised launchpad",
  noised_hook: "Noised Launch Guard hook",
  noised_vault: "Noised PQ vault",
  noised_shield: "Noised shield",
  noised_autopilot: "Noised Autopilot",
  meteora_dbc: "Meteora Dynamic Bonding Curve",
  meteora_damm_v2: "Meteora DAMM v2",
  spl_token_2022: "Token-2022",
  spl_token: "SPL Token",
  spl_associated_token_account: "Associated Token Account",
  system_program: "System Program",
  compute_budget: "Compute Budget",
};

/**
 * Programs a backend knows besides the SDK's (the autopilot program, on the simulated chain, until the SDK names it).
 * Keyed by base58 id; values are SDK-style names.
 */
const EXTRA_PROGRAMS = new Map<string, string>();

export function registerProgramName(id: string, name: string): void {
  EXTRA_PROGRAMS.set(id, name);
}

/** The SDK's name of a program, or a backend-registered one, or null. */
export function programLabelOf(id: PublicKey | string): string | null {
  return sdkProgramName(id) ?? EXTRA_PROGRAMS.get(typeof id === "string" ? id : id.toBase58()) ?? null;
}

/** Human name of a program the SDK (or the backend) recognises, or null for any other program. */
export function programDisplayName(id: PublicKey | string): string | null {
  const name = programLabelOf(id);
  return name === null ? null : (PROGRAM_DISPLAY_NAMES[name] ?? name);
}

/** Plain-English names of the certificate flags, by the SDK's `CERTIFICATE_CHECKS` key. */
const CERTIFICATE_FLAG_LABELS: Readonly<Record<string, string>> = {
  MINT_AUTHORITY_NONE: "Nobody can mint more tokens",
  FREEZE_AUTHORITY_NONE: "Nobody can freeze anyone's tokens",
  METADATA_UPDATE_AUTHORITY_NONE: "The name and symbol can never change",
  METADATA_POINTER_AUTHORITY_NONE: "The token's details point at the token itself, for good",
  EXTENSION_SET_EXACT: "No hidden token features",
  HOOK_IS_NOISED: "The launch guard is Noised's own",
  LP_PERMANENTLY_LOCKED: "All liquidity is locked forever after graduation",
  NO_MIGRATION_FEE: "No graduation fee: everything raised goes into the pool",
  NO_CREATOR_ALLOCATION: "No free tokens or head start for the creator",
  QUOTE_IS_WSOL: "Priced in SOL",
  PQ_ATTESTED: "The creator's quantum-safe key signed the launch",
  METADATA_ONCHAIN: "The token's details are stored on-chain",
};

/**
 * Every certificate flag the SDK knows (`CERTIFICATE_CHECKS`, lowest bit
 * first) with a plain-English label, so a flag the SDK adds shows up without
 * an app change (a name this table does not know is spelled out).
 */
export const CERTIFICATE_CHECK_LABELS: readonly { readonly bit: number; readonly label: string }[] = Object.entries(CERTIFICATE_CHECKS as Readonly<Record<string, number>>)
  .sort(([, a], [, b]) => a - b)
  .map(([name, bit]) => ({ bit, label: CERTIFICATE_FLAG_LABELS[name] ?? `${name.charAt(0)}${name.slice(1).toLowerCase().replaceAll("_", " ")}` }));

/** How many launch-time checks a complete certificate records: the bits of the SDK's `CERTIFICATE_ALL_CHECKS`. */
export function certificateCheckCount(): number {
  let n = 0;
  for (let v = CERTIFICATE_ALL_CHECKS; v > 0; v >>>= 1) n += v & 1;
  return n;
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];

/** "eleven" for 11 (up to sixteen; digits above). */
export function countWord(n: number): string {
  return COUNT_WORDS[n] ?? n.toString();
}

/**
 * Plain words for failures that carry no program error code: Solana
 * `TransactionError` / `InstructionError` variants and RPC transport errors,
 * matched against the raw error text only (log lines contain numbers and
 * words that would match falsely).
 */
const ERROR_HINTS: readonly (readonly [RegExp, string])[] = [
  [/\bAccountNotFound\b|no record of a prior credit/i, "The fee payer has no SOL on this cluster. Fund it first."],
  [/\bInsufficientFundsForFee\b/i, "The fee payer does not hold enough SOL for the network fee."],
  [/\bInsufficientFundsForRent\b/i, "An account would be left below its rent-exempt minimum. Add a little more SOL."],
  [/insufficient (funds|lamports)|\bInsufficientFunds\b/i, "Not enough balance for this transaction (amount plus fees and rent)."],
  [/\bBlockhashNotFound\b|blockhash not found/i, "The transaction's blockhash expired before it landed. Build it again (nothing is re-signed by a vault key)."],
  [/block height exceeded|TransactionExpired/i, "The transaction expired before it was confirmed. Check the explorer, then build it again if it did not land."],
  [/\bAlreadyProcessed\b|already been processed/i, "This exact transaction has already been processed."],
  [/\bProgramAccountNotFound\b|program that does not exist|\bUnsupportedProgramId\b/i, "A program this transaction calls is not deployed on this cluster."],
  [/\bInvalidProgramForExecution\b|\bIncorrectProgramId\b/i, "An account this transaction calls as a program is not the expected executable program."],
  [/\bComputationalBudgetExceeded\b|exceeded CUs meter/i, "The transaction ran out of compute units."],
  [/\bInvalidAccountForFee\b/i, "The fee payer cannot pay fees: it holds data or belongs to a program."],
  [/\bMissingRequiredSignature\b/i, "A required signature is missing."],
  [/\bAccountInUse\b|\bAccountLoadedTwice\b|\bTooManyAccountLocks\b/i, "The transaction's accounts are locked or repeated; try again."],
  [/WouldExceed\w*Limit/i, "The network is congested for these accounts right now; try again shortly."],
  [/\bUnsupportedVersion\b|unsupported transaction version|Transaction version \(1\)/i, "This RPC endpoint or cluster does not accept v1 transactions (SIMD-0385)."],
  [/\b429\b|Too Many Requests|rate.?limit/i, "The RPC endpoint is rate-limiting this page. Wait a moment, or build the app with a dedicated endpoint (VITE_RPC_URL)."],
  [/Failed to fetch|NetworkError|fetch failed|ERR_NETWORK|ECONNREFUSED/i, "The RPC endpoint could not be reached."],
];

/** Runtime log lines that explain a failure on their own. */
const LOG_HINTS: readonly (readonly [RegExp, string])[] = [
  [/no record of a prior credit/i, "The fee payer has no SOL on this cluster. Fund it first."],
  [/Attempt to load a program that does not exist/i, "A program this transaction calls is not deployed on this cluster."],
  [/insufficient lamports/i, "Not enough SOL for this transaction (amount plus fees and rent)."],
  [/exceeded CUs meter/i, "The transaction ran out of compute units."],
];

/** A plain-words hint for a runtime / RPC failure, or null when none applies. */
export function runtimeHint(text: string, logs: readonly string[] = []): string | null {
  for (const [re, hint] of ERROR_HINTS) if (re.test(text)) return hint;
  for (const line of logs) for (const [re, hint] of LOG_HINTS) if (re.test(line)) return hint;
  return null;
}

/** `hint (raw)` when a hint applies, otherwise the raw text. */
export function withRuntimeHint(raw: string, logs: readonly string[] = []): string {
  const hint = runtimeHint(raw, logs);
  const clean = raw.replace(/^"(.*)"$/, "$1");
  return hint === null ? clean : `${hint} (${clean})`;
}

/**
 * Token metadata is chosen by whoever created the mint: strip control and
 * bidirectional-override characters and cap the length before showing it.
 */
export function cleanLabel(text: string, maxLength: number): string | null {
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (cleaned === "") return null;
  return [...cleaned].slice(0, maxLength).join("");
}

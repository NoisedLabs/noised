/** MOCK: helpers shared by the simulated builders and reads. */
import { idlCodecs, KNOWN_ACCOUNTS, launchPdasFromLaunch, PROGRAM_IDS, type LaunchAccount } from "@noisedlabs/sdk";
import { RULES_SKIPPED_PROGRAMS } from "@noisedlabs/sdk/programmable";
import type { PublicKey } from "@solana/web3.js";

import { appErrorCode } from "../programErrors";
import { hookEvaluate, snapshot, type HookRefusal, type TransferView } from "./market";
import { mockMint } from "./mints";
import type { SimFailure } from "./sim";
import { launchByMint, type MockLaunch, type MockState } from "./store";

/**
 * Rent-exempt minimums (lamports) of the accounts these flows create:
 * `(128 + data_len) * 6960` for exact sizes, estimates for multi-account steps.
 */
export const RENT = {
  /** Launch account + DBC config (estimate). */
  launchAndConfig: 13_670_000n,
  /** Pool, vaults, certificate, meta list, policy and the mint (estimate). */
  launchAccounts: 34_820_000n,
  /** Commit (8 + 75 bytes). */
  commit: 1_468_560n,
  /** PayoutVault (82 bytes): what every commit naming one PQ vault as token owner committed together. */
  payoutVault: 1_461_600n,
  /** Token-2022 account with the TransferHookAccount extension. */
  t22Account: 2_074_080n,
  /** SPL Token account (165 bytes). */
  splAccount: 2_039_280n,
  /** Vault v4 (8 + 166 bytes). */
  vault: 2_101_920n,
  /** Payout (8 + 114 bytes); returned to its rent payer when the payout is delivered. */
  payout: 1_740_000n,
  /** Shield + zToken mint + escrow. */
  shield: 7_516_800n,
} as const;

/**
 * Code of a named error, from the program's IDL (the SDK's copy), so the mock can never use a stale number; an error
 * the SDK's IDL does not name yet comes from the app's table (lib/programErrors.ts), like the live explanations.
 */
export function errorCode(program: "launchpad" | "hook" | "vault" | "shield", name: string): number {
  const e = (idlCodecs()[program].idl.errors ?? []).find((x) => x.name === name);
  const code = e?.code ?? appErrorCode(program, name);
  if (code === null) throw new Error(`unknown ${program} error ${name}`);
  return code;
}

export const launchFail = (name: string): SimFailure => ({ kind: "program", program: PROGRAM_IDS.launchpad, code: errorCode("launchpad", name) });
export const vaultFail = (name: string): SimFailure => ({ kind: "program", program: PROGRAM_IDS.vault, code: errorCode("vault", name) });
export const shieldFail = (name: string): SimFailure => ({ kind: "program", program: PROGRAM_IDS.shield, code: errorCode("shield", name) });
export const dbcFail = (code: number): SimFailure => ({ kind: "program", program: PROGRAM_IDS.dbc, code });
export const dammFail = (code: number): SimFailure => ({ kind: "program", program: PROGRAM_IDS.dammV2, code });
export const runtime = (message: string): SimFailure => ({ kind: "runtime", message });

/** A Launch Guard refusal surfacing through the CPI chain `via` (outermost first). */
export function hookFail(refusal: HookRefusal, via: PublicKey[]): SimFailure {
  return { kind: "program", program: PROGRAM_IDS.hook, code: errorCode("hook", refusal), via };
}

export function findLaunch(s: MockState, launch: PublicKey): MockLaunch {
  const l = s.launches[launch.toBase58()];
  if (!l) throw new Error(`No Noised launch at ${launch.toBase58()}`);
  return l;
}

/** The live launch of a Noised mint, or null for any other mint. */
export function liveLaunchByMint(s: MockState, mint: PublicKey): MockLaunch | null {
  return launchByMint(s, mint);
}

/** True while DBC has not revoked the Launch Guard (the curve has not completed). */
export function hookActive(l: MockLaunch | null): boolean {
  return l !== null && !l.curveComplete;
}

/** Decimals and owner program of a mint the mock knows (throws for unknown mints). */
export function mintFacts(s: MockState, mint: PublicKey): { decimals: number; tokenProgram: PublicKey } {
  const m = mockMint(s, mint);
  if (!m) throw new Error(`Mint ${mint.toBase58()} does not exist on this cluster.`);
  return { decimals: m.decimals, tokenProgram: m.tokenProgram };
}

/**
 * Custom launch rules (PROGRAMMABLE_V1 §1.2), evaluated LAST by the hook, after every built-in allow and refusal.
 * Installed by ./programmable.ts (which holds the published rule sets and what each attestation binds); null until then.
 */
let customRules: ((l: MockLaunch, now: number, t: TransferView) => { rule: number; code: number } | null) | null = null;

export function installCustomRules(fn: typeof customRules): void {
  customRules = fn;
}

/** The Launch Guard decision for a transfer of a Noised mint (null: allowed, or not a Noised mint). */
export function guard(l: MockLaunch | null, now: number, t: TransferView, via: PublicKey[]): SimFailure | null {
  if (!l) return null;
  const refusal = hookEvaluate(l, now, t);
  if (refusal) return hookFail(refusal, via);
  // Only what the built-in guard allowed reaches the custom rules, and they can only refuse more.
  if (customRules === null || !customRulesApply(l, now, t)) return null;
  return customRules(l, now, t) !== null ? hookFail("RuleDenied", via) : null;
}

/**
 * Attestation v3 (PROGRAMMABLE_V1 §2) on the simulated chain: the rules hash an attestation's signed message binds.
 * The attestation attests only when that rule set is published (else the signature only burns its leaf, as for the
 * metadata record); when it lands the hash is recorded (./programmable.ts holds it), and `launch` refuses while a
 * bound rule set is missing. Installed by ./programmable.ts; until then every attestation binds no rules.
 */
export interface AttestationRules {
  /**
   * False when the message binds a rule set that is not published (the attestation would only burn its leaf). The
   * rules hash is the v3 message's own (`rulesHash`), else the one recorded for the message hash.
   */
  attestOk: (st: MockState, launch: string, messageHash: Uint8Array, rulesHash: Uint8Array) => boolean;
  /** An attestation of `launch` landed for the message with this hash (and the message's rules hash). */
  onAttested: (st: MockState, launch: string, messageHash: Uint8Array, rulesHash: Uint8Array) => void;
  /** The published bytes of a rule set (null: none). */
  rulesRecord: (launch: string, rulesHash: Uint8Array) => Uint8Array | null;
  /** Why `launch` refuses to open over its custom rules, or null. */
  launchCheck: (st: MockState, launch: string) => SimFailure | null;
}
let attestationRules: AttestationRules | null = null;

export function installAttestationRules(r: AttestationRules): void {
  attestationRules = r;
}

export function attestationRulesOk(st: MockState, launch: string, messageHash: Uint8Array, rulesHash: Uint8Array): boolean {
  return attestationRules?.attestOk(st, launch, messageHash, rulesHash) ?? rulesHash.every((b) => b === 0);
}

export function attestationLanded(st: MockState, launch: string, messageHash: Uint8Array, rulesHash: Uint8Array): void {
  attestationRules?.onAttested(st, launch, messageHash, rulesHash);
}

/** The published bytes of a launch's rule set (null: none, or not installed). */
export function publishedRules(launch: string, rulesHash: Uint8Array): Uint8Array | null {
  return attestationRules?.rulesRecord(launch, rulesHash) ?? null;
}

export function launchRulesProblem(st: MockState, launch: string): SimFailure | null {
  return attestationRules?.launchCheck(st, launch) ?? null;
}

/**
 * Fees `distribute` pays to a launch's own Autopilot treasury (`["treasury", launch]` of the autopilot program): its
 * wSOL account is what the autopilot spends, which ./programmable.ts keeps. Installed by ./programmable.ts; returns
 * true when it took the payment (then the core chain does not credit the address as well).
 */
let feeSink: ((st: MockState, launch: string, wallet: PublicKey, lamports: bigint) => boolean) | null = null;

export function installFeeSink(fn: typeof feeSink): void {
  feeSink = fn;
}

export function payToFeeSink(st: MockState, launch: string, wallet: PublicKey, lamports: bigint): boolean {
  return feeSink?.(st, launch, wallet, lamports) ?? false;
}

/**
 * The hook's structural allows that come before any custom rule: no policy, sells, the guard's end, the batch, zero,
 * exempt owners; and (review 4, R1) a move made by the Noised vault or shield (the transaction's current top-level
 * instruction is theirs): holders' quantum custody and privacy exits never meet the creator's rules. The built-in
 * checks (hookEvaluate) still apply to them.
 */
function customRulesApply(l: MockLaunch, now: number, t: TransferView): boolean {
  if (l.curveComplete || l.certificate === null) return false;
  if (t.topProgram !== undefined && RULES_SKIPPED_PROGRAMS.includes(t.topProgram.toBase58())) return false;
  if (t.isSell && !t.isBuy) return false;
  if (BigInt(now) >= l.state.guardEndTs) return false;
  if (t.inBatch === true || t.amount === 0n) return false;
  const pdas = launchPdasFromLaunch(l.address);
  const exempt = (k: PublicKey | null): boolean => k !== null && (k.equals(pdas.batchAuthority) || k.equals(pdas.launchAuthority));
  return !exempt(t.sourceOwner) && !exempt(t.destinationOwner);
}

export function toLaunchAccount(l: MockLaunch): LaunchAccount {
  const market = snapshot(l);
  const account: LaunchAccount = { ...l.state, recipients: l.state.recipients.map((x) => ({ ...x })), publicKey: l.address };
  if (market) account.market = market;
  return account;
}

export const T22 = KNOWN_ACCOUNTS.token2022;
export const SPL = KNOWN_ACCOUNTS.splToken;

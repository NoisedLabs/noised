/**
 * Simple mode of the create wizard (LAYER_V1 §B.2): every number a creator would type becomes a choice (cards) or a
 * slider with fixed stops, bounded to the launch policy's safe ranges (`validateLaunchParams`), with a plain sentence
 * saying what it does. Each control writes the draft's own strings (the same ones the exact inputs under "Advanced"
 * edit), so the parameters that get validated, hashed and signed come from `convertDraft` exactly as before.
 * test/simple-mode.test.ts runs every stop and card through `convertDraft` and `validateLaunchParams`.
 *
 * Pure functions only.
 */
import { parsePercentToBps, parseUnits, SOL_DECIMALS } from "../../lib/amounts";
import { MIGRATION_FEE_TIERS_BPS, POLICY } from "../../lib/noised";
import { dynamicDraftFor, feePctString, type Draft, type RecipientDraft } from "./draft";

const LAMPORTS = 1_000_000_000n;

// --------------------------------------------------------------- strings ---

/** Lamports as the draft's SOL string ("85", "0.5"). */
export function solText(lamports: bigint): string {
  const whole = lamports / LAMPORTS;
  const frac = (lamports % LAMPORTS).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/** Basis points as the draft's percent string ("1", "0.5", "33.33"). */
export function pctText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}` : `${whole}.${frac}`;
}

/** A positive decimal string times a whole number, exactly ("0.00000003" x 5 = "0.00000015"); "" if it is not a number. */
export function mulDecimal(text: string, times: number): string {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (m === null || (m[1] ?? "") + (m[2] ?? "") === "") return "";
  const frac = m[2] ?? "";
  const product = BigInt(`${m[1] ?? ""}${frac}` || "0") * BigInt(times);
  const digits = product.toString().padStart(frac.length + 1, "0");
  const whole = digits.slice(0, digits.length - frac.length);
  const rest = digits.slice(digits.length - frac.length).replace(/0+$/, "");
  return rest === "" ? whole : `${whole}.${rest}`;
}

/** The same decimal written canonically ("0.00000040" -> "0.0000004"), or null when it is not a plain number. */
export function canonicalDecimal(text: string): string | null {
  const t = mulDecimal(text, 1);
  return t === "" ? null : t;
}

/** Durations in plain words: "1 minute", "30 minutes", "6 hours", "72 hours". */
export function plainDuration(secs: number): string {
  if (secs < 3600) {
    const m = Math.round(secs / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.round((secs / 3600) * 10) / 10;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

const lamportsOf = (text: string): bigint | null => {
  try {
    return parseUnits(text, SOL_DECIMALS);
  } catch {
    return null;
  }
};

const bpsOf = (text: string): number | null => {
  try {
    return parsePercentToBps(text);
  } catch {
    return null;
  }
};

/** The stop nearest to `value` (ties: the lower one). */
export function nearestIndex(stops: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs((stops[i] ?? 0) - value) < Math.abs((stops[best] ?? 0) - value)) best = i;
  return best;
}

// ------------------------------------------------------------ price curve ---

/** Graduation goals (SOL raised), inside the policy's 1 to 100,000 SOL. */
export const GOAL_STOPS_SOL: readonly number[] = [10, 20, 40, 60, 85, 100, 150, 250, 400, 600, 1000].filter(
  (s) => BigInt(s) * LAMPORTS >= POLICY.MIN_THRESHOLD && BigInt(s) * LAMPORTS <= POLICY.MAX_THRESHOLD,
);

/** The goal in SOL as written in the draft (null when it is not a number). */
export function goalSol(d: Pick<Draft, "thresholdSol">): number | null {
  const l = lamportsOf(d.thresholdSol);
  return l === null ? null : Number(l) / 1e9;
}

/**
 * A new goal. The batch caps follow it so they stay inside the policy: a per-wallet cap is kept at least 1/200 of
 * what the batch can take (the protection card that was chosen sets it again for the new goal), and a total cap
 * outside a tenth to all of the goal goes back to "the whole goal".
 */
export function goalPatch(d: Draft, sol: number): Partial<Draft> {
  const before = protectionOf(d);
  const next: Draft = { ...d, thresholdSol: String(sol) };
  const threshold = BigInt(sol) * LAMPORTS;
  const total = lamportsOf(d.batchTotalCapSol);
  const patch: Partial<Draft> = { thresholdSol: String(sol) };
  if (total !== null && total !== 0n && (total > threshold || total < threshold / POLICY.MIN_BATCH_TOTAL_CAP_DIVISOR)) {
    patch.batchTotalCapSol = "0";
    next.batchTotalCapSol = "0";
  }
  if (before !== null) {
    patch.batchWalletCapSol = protectionCapText(next, before);
  } else {
    const cap = lamportsOf(d.batchWalletCapSol);
    const min = resolvedBatchTotal(next) / POLICY.MIN_BATCH_WALLET_CAP_DIVISOR;
    if (cap !== null && cap !== 0n && cap < min) patch.batchWalletCapSol = solText(ladderAtLeast(min, min));
  }
  return patch;
}

/** How fast the price climbs, from the first buy to graduation. */
export const RISES: readonly { id: string; title: string; times: number }[] = [
  { id: "gentle", title: "Gentle", times: 5 },
  { id: "steady", title: "Steady", times: 10 },
  { id: "steep", title: "Steep", times: 25 },
];

/** The graduation price `times` the start price (the start price stays; the curve is designed from both). */
export function risePatch(d: Pick<Draft, "startPrice">, times: number): Partial<Draft> {
  return { graduationPrice: mulDecimal(d.startPrice, times), rawCurve: false };
}

/** The rise the draft's prices make (graduation / start), or null. */
export function riseOf(d: Pick<Draft, "startPrice" | "graduationPrice">): number | null {
  const a = Number(d.startPrice);
  const b = Number(d.graduationPrice);
  return a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b) ? b / a : null;
}

/** The rise card whose exact prices the draft has (null: prices set by a preset or under Advanced). */
export function selectedRise(d: Pick<Draft, "startPrice" | "graduationPrice" | "rawCurve">): string | null {
  if (d.rawCurve) return null;
  const g = canonicalDecimal(d.graduationPrice);
  return RISES.find((r) => mulDecimal(d.startPrice, r.times) === g)?.id ?? null;
}

/** The pool's fee after graduation: DAMM v2's fixed tiers, as choices. */
export const AFTER_FEES: readonly { option: number; bps: number }[] = MIGRATION_FEE_TIERS_BPS.map((bps, option) => ({ option, bps }));

// ------------------------------------------------------------------ fees ---

/**
 * The trading fee on the curve (flat; the largest dynamic fee is a fifth of it, like every preset): 0.25% (DBC's
 * floor) to 8%, so fee plus dynamic fee stays under the 10% ceiling.
 */
export const FEE_STOPS_BPS: readonly number[] = [25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 800];

/** A flat fee of `bps`, its dynamic fee recomputed (at most a fifth more when the price moves fast). */
export function feePatch(bps: number): Partial<Draft> {
  const cliffFeePct = pctText(bps);
  return { cliffFeePct, feeMode: "0", feePeriods: "0", feePeriodSecs: "0", feeReduction: "0", dynamicFee: true, ...(dynamicDraftFor(cliffFeePct) ?? {}) };
}

/** The draft's starting fee in bps (rounded), or null. */
export function feeBpsOf(d: Pick<Draft, "cliffFeePct">): number | null {
  try {
    return Number(parseUnits(d.cliffFeePct, 7) / 100_000n);
  } catch {
    return null;
  }
}

/** Whether the fee is exactly what the slider makes (a flat stop with the dynamic fee it sets). */
export function feeIsSimple(d: Draft): boolean {
  const bps = feeBpsOf(d);
  if (bps === null || !FEE_STOPS_BPS.includes(bps)) return false;
  const p = feePatch(bps);
  return (Object.keys(p) as (keyof Draft)[]).every((k) => d[k] === p[k]);
}

/** Shares that add up to exactly 100% (2 decimals): equal, the last one taking the rounding. */
export function evenShares(n: number): string[] {
  if (n <= 0) return [];
  const each = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => pctText(i === n - 1 ? 10_000 - each * (n - 1) : each));
}

/** The recipients split evenly. */
export function evenSplit(recipients: readonly RecipientDraft[]): RecipientDraft[] {
  const shares = evenShares(recipients.length);
  return recipients.map((r, i) => ({ ...r, pct: shares[i] ?? "0" }));
}

/** Two recipients: the first gets `firstPct` whole percent (1 to 99), the second the rest. */
export function twoWaySplit(recipients: readonly RecipientDraft[], firstPct: number): RecipientDraft[] {
  const a = Math.max(1, Math.min(99, Math.round(firstPct)));
  return recipients.map((r, i) => ({ ...r, pct: i === 0 ? String(a) : String(100 - a) }));
}

/** The shares as whole bps, or null when one does not parse. */
export function sharesBps(recipients: readonly RecipientDraft[]): number[] | null {
  const out: number[] = [];
  for (const r of recipients) {
    const b = bpsOf(r.pct);
    if (b === null) return null;
    out.push(b);
  }
  return out;
}

// ------------------------------------------------------------------ rules ---

/** The opening batch's length: the policy's 1 to 30 minutes. */
export const BATCH_STOPS_SECS: readonly number[] = [60, 120, 180, 300, 600, 900, 1200, 1800].filter((s) => s >= POLICY.MIN_OPEN_DELAY && s <= POLICY.MAX_OPEN_DELAY);

/** How long the early limits last: 1 to 72 hours (always longer than the batch plus its 10-minute execution window). */
export const GUARD_STOPS_SECS: readonly number[] = [3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200].filter(
  (s) => s <= POLICY.MAX_GUARD_SECS && s >= POLICY.MAX_OPEN_DELAY + POLICY.EXECUTION_GRACE_SECS,
);

/** A batch length; the early limits are lengthened if they would end before the batch can run. */
export function batchPatch(d: Pick<Draft, "guardSecs">, secs: number): Partial<Draft> {
  const guard = Number(d.guardSecs);
  const min = secs + POLICY.EXECUTION_GRACE_SECS;
  if (Number.isSafeInteger(guard) && guard >= min) return { openDelaySecs: String(secs) };
  return { openDelaySecs: String(secs), guardSecs: String(GUARD_STOPS_SECS.find((g) => g >= min) ?? POLICY.MAX_GUARD_SECS) };
}

export function guardPatch(secs: number): Partial<Draft> {
  return { guardSecs: String(secs) };
}

export interface Protection {
  id: "light" | "balanced" | "community";
  title: string;
  maxWalletBps: number;
  maxBuyBps: number;
  p2pLocked: boolean;
  /** The per-wallet amount in the opening batch, as a share of what the batch can take (null: no limit). */
  capDivisor: bigint | null;
}

/** The three ways to hold back big wallets early (the Turbo, Fair and Community presets' settings). */
export const PROTECTIONS: readonly Protection[] = [
  { id: "light", title: "Light", maxWalletBps: 300, maxBuyBps: 0, p2pLocked: false, capDivisor: null },
  { id: "balanced", title: "Balanced", maxWalletBps: 100, maxBuyBps: 50, p2pLocked: false, capDivisor: 17n },
  { id: "community", title: "Community", maxWalletBps: 200, maxBuyBps: 100, p2pLocked: true, capDivisor: 125n },
];

/** Round SOL amounts a per-wallet batch cap snaps to. */
const CAP_LADDER: readonly bigint[] = [0.5, 1, 2, 3, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].map((s) => BigInt(Math.round(s * 1e9)));

/** The smallest ladder amount >= `min` nearest to `target` (or `min` rounded up to a whole SOL past the ladder). */
function ladderAtLeast(target: bigint, min: bigint): bigint {
  const ok = CAP_LADDER.filter((c) => c >= min);
  if (ok.length === 0) return ((min + LAMPORTS - 1n) / LAMPORTS) * LAMPORTS;
  let best = ok[0] ?? min;
  for (const c of ok) {
    const d = c > target ? c - target : target - c;
    const bd = best > target ? best - target : target - best;
    if (d < bd) best = c;
  }
  return best;
}

/** What the batch can take: its total cap, or the whole goal (0 = the goal). */
export function resolvedBatchTotal(d: Pick<Draft, "thresholdSol" | "batchTotalCapSol">): bigint {
  const total = lamportsOf(d.batchTotalCapSol);
  const threshold = lamportsOf(d.thresholdSol) ?? 0n;
  return total === null || total === 0n ? threshold : total;
}

/** The per-wallet batch cap a protection sets for this draft's goal, as the draft's SOL string ("0": none). */
export function protectionCapText(d: Pick<Draft, "thresholdSol" | "batchTotalCapSol">, p: Protection): string {
  if (p.capDivisor === null) return "0";
  const total = resolvedBatchTotal(d);
  return solText(ladderAtLeast(total / p.capDivisor, total / POLICY.MIN_BATCH_WALLET_CAP_DIVISOR));
}

export function protectionPatch(d: Draft, p: Protection): Partial<Draft> {
  return { maxWalletPct: pctText(p.maxWalletBps), maxBuyPct: pctText(p.maxBuyBps), p2pLocked: p.p2pLocked, batchWalletCapSol: protectionCapText(d, p) };
}

/** The protection card whose exact settings the draft has (null: set under Advanced). */
export function protectionOf(d: Draft): Protection | null {
  const wallet = bpsOf(d.maxWalletPct);
  const buy = bpsOf(d.maxBuyPct);
  const cap = lamportsOf(d.batchWalletCapSol);
  return (
    PROTECTIONS.find((p) => p.maxWalletBps === wallet && p.maxBuyBps === buy && p.p2pLocked === d.p2pLocked && lamportsOf(protectionCapText(d, p)) === cap) ?? null
  );
}

// ------------------------------------------------------- plain sentences ---

/** "No wallet can hold more than 1% of the supply, or buy more than 0.5% at once" and the rest, from the draft. */
export function limitsSentence(d: Pick<Draft, "maxWalletPct" | "maxBuyPct" | "p2pLocked">): string {
  const wallet = bpsOf(d.maxWalletPct);
  const buy = bpsOf(d.maxBuyPct);
  const parts: string[] = [];
  if (wallet !== null && wallet > 0) parts.push(`no wallet can hold more than ${pctText(wallet)}% of the supply`);
  if (buy !== null && buy > 0) parts.push(`no single buy can take more than ${pctText(buy)}%`);
  if (d.p2pLocked) parts.push("tokens cannot move between wallets");
  if (parts.length === 0) return "there are no limits on wallets";
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

/** The batch's per-wallet cap in words ("each wallet can put in at most 5 SOL" / "no per-wallet limit"). */
export function batchCapSentence(d: Pick<Draft, "batchWalletCapSol">): string {
  const cap = lamportsOf(d.batchWalletCapSol);
  return cap === null || cap === 0n ? "no limit per wallet" : `at most ${solText(cap)} SOL per wallet`;
}

/** "1%" for the pool's fee after graduation. */
export const afterFeeText = (option: number): string => `${(MIGRATION_FEE_TIERS_BPS[option] ?? 0) / 100}%`;

/** "1.2%": the fee plus its largest dynamic part (a fifth), for the fee slider's sentence. */
export const feeWithDynamicText = (bps: number): string => `${pctText(Math.round(bps * 1.2))}%`;

/** The fee as written in the draft, as a percent ("1.25"), for sentences. */
export const feePctOf = (d: Pick<Draft, "cliffFeePct">): string => {
  try {
    return feePctString(parseUnits(d.cliffFeePct, 7));
  } catch {
    return d.cliffFeePct;
  }
};

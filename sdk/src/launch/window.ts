/**
 * The clock and the attested launch window (PQ v2): the one canonical set of
 * time helpers for the whole package.
 *
 * # One type for "now"
 *
 * Every "now" the SDK takes or returns is a `bigint` of unix SECONDS, named
 * `nowSecs` (`launchPhase`, `batchOutcome`, `VerifyOptions`,
 * `LaunchTxOptions`, `getLaunchFlowStatus`, `planLaunch`, and every helper
 * below). Why bigint and not number: the program's clock and every timestamp
 * the SDK decodes are `i64` (`LaunchAccount.commitEndTs`, an attestation's
 * `notBefore` / `notAfter`, `clusterUnixTime`), and the SDK maps every i64 to
 * a bigint; comparing a bigint with a bigint needs no conversion and cannot
 * round, while a `number` would also accept `NaN`, fractions and silently
 * mixed comparisons. A `number` is refused with a `TypeError`, and a value
 * that looks like `Date.now()` milliseconds (|nowSecs| >= 10^11, the year
 * 5138) with a `RangeError`, by every function that takes a "now", the
 * window helpers below included: use `unixNowSecs()` (local clock) or
 * `clusterUnixTime(conn)` (the cluster's, what the program compares with).
 * `clusterUnixTime` refuses a cluster clock outside that range too (an RPC
 * that is broken or lying), naming the RPC rather than the caller.
 *
 * The window's own ends (`notBefore`, `notAfter`) are what the attestation
 * records: they must be bigints, and any i64 is judged exactly as the
 * program judges it (a window that looks like milliseconds is never valid
 * at a plausible now, and the problems say so).
 *
 * # The window
 *
 * An attestation records `[notBefore, notAfter]` only when
 * `pq::launch_window_is_valid` holds at the moment it lands: it lasts
 * 60..=3,600 s, at least 60 s of it are left (`max(now, notBefore) + 60 <=
 * notAfter`, audit round 3 F1: a window landing in its last seconds could
 * never be used) and it opens at most 7 days later (`notBefore <= now +
 * 604,800`). `launch` then runs only inside it, both ends inclusive
 * (`pq::in_launch_window`). A signature over a window that is invalid when
 * it lands only burns its leaf, so check before signing
 * (`validateLaunchWindow`, with a landing margin). An attestation whose
 * window passed unused (the launch still `Configured`) can be replaced by a
 * new one with a new window: the creator signs a new opening time.
 */
import { SYSVAR_CLOCK_PUBKEY, type Connection } from "@solana/web3.js";

import { I64_MAX, I64_MIN } from "../codec/bytes.js";
import { POLICY } from "../constants.js";
import { getAccount } from "../rpc/fetch.js";
import type { ValidationResult } from "../types.js";

/** Shortest launch window an attestation records (`constants::MIN_LAUNCH_WINDOW_SECS`). */
export const MIN_LAUNCH_WINDOW_SECS = BigInt(POLICY.MIN_LAUNCH_WINDOW_SECS);
/** Longest launch window (`constants::MAX_LAUNCH_WINDOW_SECS`); also the suggested length. */
export const MAX_LAUNCH_WINDOW_SECS = BigInt(POLICY.MAX_LAUNCH_WINDOW_SECS);
/** Latest a window may open after the attestation lands (`constants::MAX_LAUNCH_LEAD_SECS`, 7 days). */
export const MAX_LAUNCH_LEAD_SECS = BigInt(POLICY.MAX_LAUNCH_LEAD_SECS);
/** Default seconds allowed between signing and landing when a window is checked before signing (`validateLaunchWindow`, `buildAttestLaunchTx`). */
export const ATTEST_LANDING_MARGIN_SECS = 300n;
/** At or above this a "unix seconds" value is almost surely `Date.now()` milliseconds (year 5138). */
const MS_SUSPECT = 100_000_000_000n;

const isI64 = (v: bigint): boolean => v >= I64_MIN && v <= I64_MAX;

/**
 * Refuse anything but plausible bigint unix seconds for a "now": a `number`
 * (TypeError: the SDK's one type for now is bigint), a value outside i64 or
 * one that looks like milliseconds (RangeError). Internal to the SDK.
 */
export function checkNowSecs(nowSecs: unknown, what = "nowSecs"): bigint {
  if (typeof nowSecs !== "bigint") {
    throw new TypeError(`${what} must be a bigint of unix seconds (got ${typeof nowSecs}): use unixNowSecs() or clusterUnixTime(conn)`);
  }
  if (!isI64(nowSecs)) throw new RangeError(`${what} is outside i64`);
  if (nowSecs >= MS_SUSPECT || nowSecs <= -MS_SUSPECT) throw new RangeError(`${what} looks like milliseconds (Date.now()): use unix seconds`);
  return nowSecs;
}

/** Whether a clock value read from the chain is plausible unix seconds (|t| < 10^11). Internal. */
export function plausibleUnixSecs(t: bigint): boolean {
  return t < MS_SUSPECT && t > -MS_SUSPECT;
}

function checkTimes(values: readonly unknown[]): void {
  for (const v of values) if (typeof v !== "bigint") throw new TypeError("times must be bigint unix seconds");
}

/** Largest unix second `Date` can show as a year-9999 ISO date. */
const ISO_MAX_SECS = 253_402_300_799n;

/**
 * Unix seconds as an absolute UTC ISO 8601 date, `"2026-10-12T14:00:00Z"`
 * (audit 4, ID-F5: every window, activation time and freeze expiry is shown
 * as an absolute date as well as a duration). A time before 1970 or past
 * the year 9999 reads `"unix <t>"`.
 */
export function unixToIso(t: bigint): string {
  if (typeof t !== "bigint") throw new TypeError("t must be bigint unix seconds");
  if (t < 0n || t > ISO_MAX_SECS) return `unix ${t}`;
  return new Date(Number(t) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Unix seconds as a short plain date for UI lines, `"2026-10-12 14:00 UTC"` (`"unix <t>"` outside 1970..9999). */
export function unixToUtcText(t: bigint): string {
  const iso = unixToIso(t);
  return iso.startsWith("unix") ? iso : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Local unix time in SECONDS (`Date.now()` is milliseconds). Prefer the cluster's clock (`clusterUnixTime`) where the program decides. */
export function unixNowSecs(nowMs: number = Date.now()): bigint {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs must be a finite number of milliseconds");
  return BigInt(Math.floor(nowMs / 1000));
}

/**
 * The cluster's unix time in SECONDS (Clock sysvar): what the programs
 * compare windows and phases with. Throws when the RPC returns no clock, or
 * one that is not plausible unix seconds (|t| >= 10^11): that RPC is broken
 * or dishonest, and nothing should be decided on its clock.
 */
export async function clusterUnixTime(conn: Connection): Promise<bigint> {
  const clock = await getAccount(conn, SYSVAR_CLOCK_PUBKEY);
  if (clock === null || clock.data.length < 40) throw new Error("could not read the cluster clock (Clock sysvar)");
  const t = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength).getBigInt64(32, true);
  if (!plausibleUnixSecs(t)) throw new Error(`the cluster clock (Clock sysvar) your RPC returned reads ${t}, which is not plausible unix seconds: the RPC is broken or dishonest; use another RPC`);
  return t;
}

/**
 * `pq::launch_window_is_valid`'s problems over any i64 values, with no check
 * of the clock: the program's predicate, for a clock read from the chain (a
 * landing's time, a test bank's). Internal; the exported helpers check the
 * caller's `nowSecs` first.
 */
export function windowProblemsAt(nowSecs: bigint, notBefore: bigint, notAfter: bigint): string[] {
  const times = [nowSecs, notBefore, notAfter];
  if (!times.every((v) => typeof v === "bigint" && isI64(v))) return ["times must be i64 unix seconds (bigint)"];
  const problems: string[] = [];
  const length = notAfter - notBefore;
  if (length < MIN_LAUNCH_WINDOW_SECS || length > MAX_LAUNCH_WINDOW_SECS) {
    problems.push(`the window must last ${MIN_LAUNCH_WINDOW_SECS} to ${MAX_LAUNCH_WINDOW_SECS} seconds (is ${length})`);
  }
  if (nowSecs > notAfter) problems.push("the window has already ended");
  else if ((nowSecs > notBefore ? nowSecs : notBefore) + MIN_LAUNCH_WINDOW_SECS > notAfter) {
    problems.push(`less than ${MIN_LAUNCH_WINDOW_SECS} seconds of the window would be left when it lands`);
  }
  if (notBefore > nowSecs + MAX_LAUNCH_LEAD_SECS) problems.push(`the window must open within ${MAX_LAUNCH_LEAD_SECS / 86_400n} days`);
  if (problems.length > 0 && times.some((v) => v >= MS_SUSPECT || v <= -MS_SUSPECT)) problems.push("the window looks like milliseconds: use unix seconds");
  return problems;
}

/** `pq::launch_window_is_valid` over any i64 values, with no check of the clock (see `windowProblemsAt`). Internal. */
export function windowValidAt(nowSecs: bigint, notBefore: bigint, notAfter: bigint): boolean {
  checkTimes([nowSecs, notBefore, notAfter]);
  return windowProblemsAt(nowSecs, notBefore, notAfter).length === 0;
}

/**
 * Why an attestation landing at `nowSecs` would NOT record this window
 * (`pq::launch_window_is_valid`, exactly): it must last 60..=3,600 s, must
 * have at least 60 s left (`max(nowSecs, notBefore) + 60 <= notAfter`) and
 * must open at most 7 days after it lands. Empty exactly when `launchWindowIsValid` is true. `nowSecs` is
 * checked like every "now" (a `number` is a TypeError; outside i64 or
 * looking like milliseconds, a RangeError); `notBefore` and `notAfter` must
 * be bigints (TypeError), and window ends outside i64 are one problem; an
 * invalid window whose values look like milliseconds says so. A signature
 * over an invalid window lands only to burn its leaf, so never sign one, and
 * leave time to land (`validateLaunchWindow`).
 */
export function launchWindowProblems(nowSecs: bigint, notBefore: bigint, notAfter: bigint): string[] {
  checkNowSecs(nowSecs);
  checkTimes([notBefore, notAfter]);
  return windowProblemsAt(nowSecs, notBefore, notAfter);
}

/**
 * Exactly `pq::launch_window_is_valid` (i128 arithmetic in the program,
 * bigint here: no overflow) at a plausible `nowSecs`: an attestation landing
 * at `nowSecs` records the window `[notBefore, notAfter]`. `nowSecs` is
 * checked like every "now" (TypeError for a `number`, RangeError outside i64
 * or for milliseconds); `notBefore` and `notAfter` must be bigints
 * (TypeError); false for window ends outside i64 (the program cannot
 * receive them).
 */
export function launchWindowIsValid(nowSecs: bigint, notBefore: bigint, notAfter: bigint): boolean {
  return launchWindowProblems(nowSecs, notBefore, notAfter).length === 0;
}

/**
 * `pq::in_launch_window`: `launch` may run at `nowSecs` (`notBefore <=
 * nowSecs <= notAfter`, both inclusive). `nowSecs` is checked like every
 * "now" (so `BigInt(Date.now())` is a RangeError, never a silent "not in
 * the window"); `notBefore` and `notAfter` must be bigints (TypeError).
 */
export function inLaunchWindow(nowSecs: bigint, notBefore: bigint, notAfter: bigint): boolean {
  checkNowSecs(nowSecs);
  checkTimes([notBefore, notAfter]);
  return notBefore <= nowSecs && nowSecs <= notAfter;
}

/**
 * Check a window before signing, at `opts.nowSecs` (the cluster's clock, or
 * `unixNowSecs()`): it must be valid for a landing anywhere in
 * `nowSecs ..= nowSecs + landingMarginSecs` (default
 * `ATTEST_LANDING_MARGIN_SECS`, 300 s), so it must end at least
 * `landingMarginSecs + 60` s after `nowSecs` (60 s must be left when it
 * lands), in seconds, and in i64. Every
 * problem of the window is reported as `"field: message"`. `opts.nowSecs`
 * is checked like every "now" (TypeError for a `number`, RangeError outside
 * i64 or for milliseconds); the margin must be a bigint >= 0 (TypeError).
 */
export function validateLaunchWindow(
  notBefore: bigint,
  notAfter: bigint,
  opts: { readonly nowSecs: bigint; readonly landingMarginSecs?: bigint | undefined },
): ValidationResult {
  if (opts !== null && typeof opts === "object" && "now" in opts) throw new TypeError("validateLaunchWindow: opts.now is now opts.nowSecs (bigint unix seconds)");
  const margin = opts.landingMarginSecs ?? ATTEST_LANDING_MARGIN_SECS;
  if (typeof opts.nowSecs !== "bigint" || typeof margin !== "bigint" || margin < 0n) throw new TypeError("nowSecs and landingMarginSecs must be bigint seconds (margin >= 0)");
  checkNowSecs(opts.nowSecs, "opts.nowSecs");
  const errors: string[] = [];
  if (typeof notBefore !== "bigint") errors.push("notBefore: must be a bigint of unix seconds");
  if (typeof notAfter !== "bigint") errors.push("notAfter: must be a bigint of unix seconds");
  if (errors.length > 0) return { ok: false, errors };
  for (const [field, v] of [["notBefore", notBefore], ["notAfter", notAfter]] as const) {
    if (!isI64(v)) errors.push(`${field}: out of i64 range`);
    else if (v >= MS_SUSPECT || v <= -MS_SUSPECT) errors.push(`${field}: looks like milliseconds (Date.now()); use unix seconds`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const len = notAfter - notBefore;
  if (len < MIN_LAUNCH_WINDOW_SECS || len > MAX_LAUNCH_WINDOW_SECS) {
    errors.push(`notAfter: the window must last ${MIN_LAUNCH_WINDOW_SECS}..=${MAX_LAUNCH_WINDOW_SECS} seconds (lasts ${len})`);
  }
  if (notAfter < opts.nowSecs + margin + MIN_LAUNCH_WINDOW_SECS) {
    errors.push(`notAfter: the window ends before the attestation can land with ${MIN_LAUNCH_WINDOW_SECS} s of it left (allow ${margin} s to land)`);
  }
  if (notBefore > opts.nowSecs + MAX_LAUNCH_LEAD_SECS) errors.push(`notBefore: the window must open at most ${MAX_LAUNCH_LEAD_SECS} seconds (7 days) after the attestation lands`);
  return { ok: errors.length === 0, errors };
}

/**
 * The suggested window for a launch that opens at `opensAt` (unix seconds):
 * `[opensAt, opensAt + 3,600]`, the longest the program allows. Anyone may
 * run `launch` inside it and the first transaction to land wins; a keeper
 * should send it at `notBefore`.
 */
export function defaultLaunchWindow(opensAt: bigint): { notBefore: bigint; notAfter: bigint } {
  if (typeof opensAt !== "bigint") throw new TypeError("opensAt must be bigint unix seconds");
  if (!isI64(opensAt) || opensAt > I64_MAX - MAX_LAUNCH_WINDOW_SECS) throw new RangeError("opensAt must be i64 unix seconds");
  return { notBefore: opensAt, notAfter: opensAt + MAX_LAUNCH_WINDOW_SECS };
}

/**
 * Clock sanity before the post-quantum identity signs a time (audit 4,
 * ID-F1b and ID-F5).
 *
 * Everything the identity signs that names a time (an attestation's launch
 * window, a graph's activation time, a freeze's expiry) is checked by the
 * SDK against the cluster's clock, which the RPC reports (the Clock sysvar).
 * An RPC that lies about the clock (a year ahead, say) would make every
 * check and every "in about an hour" line agree with the lie, and the
 * identity would sign a time that is usable on the real chain at a moment
 * the user never chose. So before such a signature the cluster clock is
 * compared with this device's clock and, when given, with a second RPC's:
 * they must agree within `CLOCK_SKEW_MAX_SECS` (120 s), or nothing is signed
 * (`ClockSkewError`, with a plain message). The SDK also bounds the signed
 * times against the LOCAL clock (a freeze expires at most 24 hours from now,
 * an attestation window opens at most 7 days from now) and shows them as
 * absolute dates (`unixToIso`), never only as durations.
 */
import type { Connection } from "@solana/web3.js";

import { clusterUnixTime, unixNowSecs, unixToUtcText } from "../launch/window.js";

/** Most seconds the cluster clock (and a second RPC's) may differ from this device's before a signature with a time is refused. */
export const CLOCK_SKEW_MAX_SECS = 120n;

let localSource: (() => bigint | null) | null = null;

/**
 * INTERNAL (not exported from the package root): where `localUnixSecs` reads
 * this device's clock (default `Date.now()`). The SDK's own tests point it
 * at their simulated cluster clock; `null` restores the default.
 */
export function setLocalClockSource(fn: (() => bigint | null) | null): void {
  localSource = fn;
}

/** This device's unix time in seconds (`Date.now()`, unless the SDK's tests replaced the source). Internal. */
export function localUnixSecs(): bigint {
  const v = localSource === null ? null : localSource();
  return v ?? unixNowSecs();
}

/** The cluster clock disagrees with this device's clock (or a second RPC's) by more than the allowed skew: nothing was signed. */
export class ClockSkewError extends Error {
  /** This device's clock (unix seconds). */
  readonly localSecs: bigint;
  /** The cluster clock the RPC reported (unix seconds). */
  readonly clusterSecs: bigint;
  /** The second RPC's cluster clock, when one was asked (null otherwise). */
  readonly secondClusterSecs: bigint | null;
  /** The largest difference found (seconds, positive). */
  readonly skewSecs: bigint;
  readonly maxSkewSecs: bigint;
  constructor(localSecs: bigint, clusterSecs: bigint, secondClusterSecs: bigint | null, skewSecs: bigint, maxSkewSecs: bigint) {
    const second = secondClusterSecs === null ? "" : `, a second RPC's ${unixToUtcText(secondClusterSecs)}`;
    super(
      `Nothing was signed: your RPC's clock (${unixToUtcText(clusterSecs)}${second}) and this device's clock (${unixToUtcText(localSecs)}) differ by ${skewSecs} seconds (at most ${maxSkewSecs} allowed). A wrong clock could make your quantum key sign a time you did not choose. Check this device's date and time, or use another RPC.`,
    );
    this.name = "ClockSkewError";
    this.localSecs = localSecs;
    this.clusterSecs = clusterSecs;
    this.secondClusterSecs = secondClusterSecs;
    this.skewSecs = skewSecs;
    this.maxSkewSecs = maxSkewSecs;
  }
}

/** Options of `checkClockSkew` (and of every builder that signs a time). */
export interface ClockCheckOptions {
  /** This device's unix time in seconds (default: its clock, `Date.now()`). */
  readonly localNowSecs?: bigint | undefined;
  /** A second, independent RPC: its cluster clock must agree as well. */
  readonly secondConnection?: Connection | undefined;
  /** Most seconds of disagreement allowed (default `CLOCK_SKEW_MAX_SECS`, 120). */
  readonly maxClockSkewSecs?: bigint | undefined;
}

/** What `checkClockSkew` read. */
export interface ClockCheck {
  readonly localSecs: bigint;
  readonly clusterSecs: bigint;
  readonly secondClusterSecs: bigint | null;
  /** The largest difference found (seconds). */
  readonly skewSecs: bigint;
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Compare the cluster clock (`clusterUnixTime(conn)`) with this device's
 * clock and, with `secondConnection`, with a second RPC's: throws
 * `ClockSkewError` when any two differ by more than `maxClockSkewSecs`
 * (default 120 s). Returns what it read (use `clusterSecs` as "now" for the
 * program's rules).
 */
export async function checkClockSkew(conn: Connection, opts: ClockCheckOptions = {}): Promise<ClockCheck> {
  const max = opts.maxClockSkewSecs ?? CLOCK_SKEW_MAX_SECS;
  if (typeof max !== "bigint" || max < 0n) throw new RangeError("maxClockSkewSecs must be a non-negative bigint (seconds)");
  if (opts.localNowSecs !== undefined && typeof opts.localNowSecs !== "bigint") throw new TypeError("localNowSecs must be bigint unix seconds");
  const [clusterSecs, secondClusterSecs] = await Promise.all([clusterUnixTime(conn), opts.secondConnection === undefined ? Promise.resolve(null) : clusterUnixTime(opts.secondConnection)]);
  const localSecs = opts.localNowSecs ?? localUnixSecs();
  let skew = abs(clusterSecs - localSecs);
  if (secondClusterSecs !== null) {
    const a = abs(secondClusterSecs - localSecs);
    const b = abs(secondClusterSecs - clusterSecs);
    if (a > skew) skew = a;
    if (b > skew) skew = b;
  }
  if (skew > max) throw new ClockSkewError(localSecs, clusterSecs, secondClusterSecs, skew, max);
  return { localSecs, clusterSecs, secondClusterSecs, skewSecs: skew };
}

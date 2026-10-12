/**
 * The SDK 0.9.0 guards around a quantum signature (audit 4), on the simulated
 * chain, with the SDK's own error classes so the app handles the demo and a
 * real cluster alike:
 *   - the clock (`checkClockSkew`): the network's clock must agree with this
 *     device's within `CLOCK_SKEW_MAX_SECS` before the key signs a time
 *     (`ClockSkewError`). The simulated network's clock is this device's,
 *     moved by the demo's "network clock" scenario (`DEMO_CLOCK_OFFSET_KEY`,
 *     seconds; unset = none), so the refusal can be shown;
 *   - the per-launch signing lock (`signingLock`, named `signingLockName`):
 *     the caller's (navigator.locks in the app), else one in this process;
 *   - the cap on signatures that never landed with success
 *     (`MAX_UNLANDED_SIGNATURES`, `SignatureCapError`).
 * The leaf choice itself (`UnknownLeavesError` before anything is reserved) is
 * the SDK's `signAtNextLeaf`, called as is.
 */
import { CLOCK_SKEW_MAX_SECS, ClockSkewError, signingLockName, type LeafRecord, type LedgerLock } from "@noisedlabs/sdk";
import type { PublicKey } from "@solana/web3.js";

import { nowSecs } from "./store";

/** localStorage key of the demo's network-clock scenario: how many seconds the simulated network's clock is ahead (negative: behind). */
export const DEMO_CLOCK_OFFSET_KEY = "noised.demo.network-clock-offset";

/** The demo's network-clock offset (seconds; 0 when unset or unreadable). */
export function demoNetworkClockOffset(): number {
  try {
    const v = globalThis.localStorage?.getItem(DEMO_CLOCK_OFFSET_KEY) ?? null;
    const n = v === null ? 0 : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  } catch {
    return 0;
  }
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * The SDK's `checkClockSkew` on the simulated chain: the network's clock (the simulated chain's, with the demo's
 * offset) against this device's (`localNowSecs`, default its clock). Throws `ClockSkewError` past `maxClockSkewSecs`.
 */
export function mockCheckClockSkew(opts: { localNowSecs?: bigint | undefined; maxClockSkewSecs?: bigint | undefined } = {}): { localSecs: bigint; clusterSecs: bigint } {
  const max = opts.maxClockSkewSecs ?? CLOCK_SKEW_MAX_SECS;
  if (typeof max !== "bigint" || max < 0n) throw new RangeError("maxClockSkewSecs must be a non-negative bigint (seconds)");
  if (opts.localNowSecs !== undefined && typeof opts.localNowSecs !== "bigint") throw new TypeError("localNowSecs must be bigint unix seconds");
  const clusterSecs = BigInt(nowSecs() + demoNetworkClockOffset());
  const localSecs = opts.localNowSecs ?? BigInt(Math.floor(Date.now() / 1000));
  const skew = abs(clusterSecs - localSecs);
  if (skew > max) throw new ClockSkewError(localSecs, clusterSecs, null, skew, max);
  return { localSecs, clusterSecs };
}

const held = new Map<string, Promise<unknown>>();

/** One in-process mutex per name (the SDK's default signing lock). */
function processLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const before = held.get(name) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.catch(() => undefined);
  held.set(name, tail);
  void tail.then(() => {
    if (held.get(name) === tail) held.delete(name);
  });
  return run;
}

/** Run `fn` holding `launch`'s signing lock: the caller's (`signingLock`), else this process's. */
export function withSigningLock<T>(launch: PublicKey, lock: LedgerLock | undefined, fn: () => Promise<T>): Promise<T> {
  if (lock !== undefined && typeof lock !== "function") throw new TypeError("signingLock must be a function (name, fn) => Promise");
  return (lock ?? processLock)(signingLockName(launch), fn);
}

/** The SDK's `countsAsUnlanded`: a recorded signature that has not landed with success (nor been retired on purpose). */
export function countsAsUnlanded(r: Pick<LeafRecord, "signature" | "status" | "attested" | "retired">): boolean {
  if (r.signature === null) return false;
  if (r.retired === true) return false;
  return !(r.status === "landed" && r.attested === true);
}

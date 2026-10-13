/**
 * The autopilot's buyback price bounds, mirroring
 * programs/noised-autopilot/src/reference.rs and src/price.rs exactly
 * (bigint sqrt prices in Q64.64, unix seconds as numbers).
 *
 * - Observations: `update_price` (anyone, any time) and every run record the
 *   pool's price. Per 15-minute bucket only the lowest and highest price are
 *   kept, so extra observations never hide another one.
 * - The window is the current and the previous bucket (the last 15 to 30
 *   minutes), usable once its observations span at least a minute.
 * - A buyback is priced from the lower of the reference and the lowest price
 *   observed in the window (`buybackCap`): after the market falls, one
 *   observation by anyone bounds every buyback from a minute later.
 * - The reference moves only to the edge of the window: up toward its lowest
 *   price when every observation is above it, at most 5% of price per hour
 *   from an allowance only rises spend; down to its highest price when every
 *   observation is below it, at once (`follow`).
 * - Price conditions must hold across the reference and every price
 *   observed in the window (`observed`, `conditionPrices`): PRICE_GTE on the
 *   lowest of them, PRICE_LTE on the highest. One pumped or dumped
 *   observation, even in the run's own transaction, can make a condition
 *   false, never true (review F1).
 *
 * A keeper therefore calls `update_price`, waits a minute, then runs a buyback.
 */
import { AUTOPILOT, BPS_DENOMINATOR } from "../constants.js";

/** The lowest and highest pool sqrt price observed in one bucket (empty while min === 0n). */
export interface ObsBucket {
  /** floor(unixTime / OBS_BUCKET_SECS). */
  index: number;
  /** When its first observation was made. */
  firstAt: number;
  min: bigint;
  max: bigint;
}

/** The reference price and the observations (the program's `PriceState`). */
export interface PriceState {
  /** The reference sqrt price (Q64.64). */
  reference: bigint;
  /** When it last moved. */
  updatedAt: number;
  /** The rise allowance in sqrt-bps-seconds, and when it last accrued. */
  allowance: bigint;
  allowanceAt: number;
  /** The current bucket, then the previous one. */
  observations: [ObsBucket, ObsBucket];
}

/** The lowest and highest sqrt price observed in the window. */
export interface Seen {
  min: bigint;
  max: bigint;
}

const SCALE = BigInt(BPS_DENOMINATOR) * 3_600n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export const emptyBucket = (): ObsBucket => ({ index: 0, firstAt: 0, min: 0n, max: 0n });
export const emptyObservations = (): [ObsBucket, ObsBucket] => [emptyBucket(), emptyBucket()];

/** A fresh price state at `reference` (its allowance accrues from time 0: one hour banked). */
export function newPriceState(reference: bigint): PriceState {
  return { reference, updatedAt: 0, allowance: 0n, allowanceAt: 0, observations: emptyObservations() };
}

export const bucketOf = (now: number): number => Math.floor(now / AUTOPILOT.OBS_BUCKET_SECS);

const isEmpty = (b: ObsBucket): boolean => b.min === 0n;

/** Records an observation of the pool sqrt price at `now` (a zero price is no observation). */
export function observe(obs: [ObsBucket, ObsBucket], now: number, spot: bigint): void {
  if (spot === 0n) return;
  const index = bucketOf(now);
  const cur = obs[0];
  if (!isEmpty(cur) && index <= cur.index) {
    if (spot < cur.min) cur.min = spot;
    if (spot > cur.max) cur.max = spot;
    return;
  }
  obs[1] = !isEmpty(cur) && cur.index + 1 === index ? { ...cur } : emptyBucket();
  obs[0] = { index, firstAt: now, min: spot, max: spot };
}

/** What the current and previous bucket saw at `now`, if their observations span at least a minute. */
export function seen(obs: readonly ObsBucket[], now: number): Seen | null {
  const oldest = bucketOf(now) - 1;
  let out: { s: Seen; first: number } | null = null;
  for (const b of obs) {
    if (isEmpty(b) || b.index < oldest) continue;
    out =
      out === null
        ? { s: { min: b.min, max: b.max }, first: b.firstAt }
        : {
            s: { min: out.s.min < b.min ? out.s.min : b.min, max: out.s.max > b.max ? out.s.max : b.max },
            first: Math.min(out.first, b.firstAt),
          };
  }
  if (out === null) return null;
  return now - out.first >= AUTOPILOT.OBS_MIN_SPAN_SECS ? out.s : null;
}

/**
 * `reference::observed`: the lowest and the highest price observed in the
 * current and the previous bucket at `now`, however recent (this run's own
 * observation included); null without one. What a run's price conditions
 * must hold across (`conditionPrices`, review F1) and what a burn is valued
 * at (`lowest`): more observations only make either more cautious, so none
 * needs to be a minute old.
 */
export function observed(obs: readonly ObsBucket[], now: number): Seen | null {
  const oldest = bucketOf(now) - 1;
  let out: Seen | null = null;
  for (const b of obs) {
    if (isEmpty(b) || b.index < oldest) continue;
    out = out === null ? { min: b.min, max: b.max } : { min: out.min < b.min ? out.min : b.min, max: out.max > b.max ? out.max : b.max };
  }
  return out;
}

/**
 * `reference::lowest`: the lowest price observed in the current and the
 * previous bucket at `now`, however recent (a burn's value for its tip,
 * audit 4, A4-4: a lower price only ever lowers a tip, so no observation
 * needs to be a minute old); null without one.
 */
export function lowest(obs: readonly ObsBucket[], now: number): bigint | null {
  return observed(obs, now)?.min ?? null;
}

/** The sqrt price a buyback is bounded by: min(reference, lowest observed); null without a usable window. */
export function buybackCap(reference: bigint, s: Seen | null): bigint | null {
  if (s === null) return null;
  return reference < s.min ? reference : s.min;
}

function accrue(p: PriceState, now: number): void {
  if (now <= p.allowanceAt) return;
  const elapsed = BigInt(now - p.allowanceAt);
  const a = p.allowance + elapsed * BigInt(AUTOPILOT.REF_UP_SQRT_BPS_PER_HOUR);
  p.allowance = a < AUTOPILOT.REF_ALLOWANCE_MAX ? a : AUTOPILOT.REF_ALLOWANCE_MAX;
  p.allowanceAt = now;
}

/**
 * Accrues the allowance, then moves the reference to the nearest edge of the
 * window: up toward its lowest price if every observation is above the
 * reference (by at most what the allowance allows; the rise spends it), down
 * to its highest price if every observation is below it. Returns whether it moved.
 */
export function follow(p: PriceState, s: Seen | null, now: number): boolean {
  accrue(p, now);
  if (s === null) return false;
  const r = p.reference;
  let target: bigint;
  if (s.min > r) {
    // The program's u128 math: beyond it (no DAMM v2 price is), no rise.
    const step = r * p.allowance;
    if (step > U128_MAX) return false;
    const limit = r + step / SCALE;
    target = s.min < limit ? s.min : limit;
    if (target <= r) return false;
    if ((target - r) * SCALE > U128_MAX) return false;
    const cost = ((target - r) * SCALE + r - 1n) / r; // div_ceil
    p.allowance = p.allowance > cost ? p.allowance - cost : 0n;
  } else if (s.max < r) {
    target = s.max;
  } else {
    return false;
  }
  p.reference = target;
  p.updatedAt = now;
  return true;
}

/** floor(sqrt^2 / 2^64): the Q64.64 price; null at or above 2^96 (beyond DAMM v2's range). */
export function priceQ64(sqrt: bigint): bigint | null {
  const p = (sqrt * sqrt) >> 64n;
  return p >> 128n === 0n ? p : null;
}

/** Whether `spot` is at most `premiumBps` above `bound` (prices, exact). */
export function withinPremium(spotSqrt: bigint, boundSqrt: bigint, premiumBps: number | bigint): boolean {
  const spot = priceQ64(spotSqrt);
  const bound = priceQ64(boundSqrt);
  if (spot === null || bound === null) return false;
  return spot * 10_000n <= bound * (10_000n + BigInt(premiumBps));
}

/** The least a buyback of `amountIn` lamports may return, priced at the bound plus the premium (null: none can). */
export function minOut(amountIn: bigint, boundSqrt: bigint, premiumBps: number | bigint): bigint | null {
  const price = priceQ64(boundSqrt);
  if (price === null || price === 0n) return null;
  const atBound = (amountIn << 64n) / price;
  if (atBound > U64_MAX) return null;
  return (atBound * 10_000n) / (10_000n + BigInt(premiumBps));
}

/** `amount` raw tokens in lamports at the sqrt price (floor; 0 out of range; saturating at u64). */
export function tokenValue(amount: bigint, sqrt: bigint): bigint {
  const price = priceQ64(sqrt);
  if (price === null) return 0n;
  const v = (amount * price) >> 64n;
  return v > U64_MAX ? U64_MAX : v;
}

/** The least a keeper may choose for a buyback: KEEPER_MIN_POOL_BPS of the pool's SOL (lamports). */
export function keeperFloor(poolLamports: bigint): bigint {
  return (poolLamports * BigInt(AUTOPILOT.KEEPER_MIN_POOL_BPS)) / BigInt(BPS_DENOMINATOR);
}

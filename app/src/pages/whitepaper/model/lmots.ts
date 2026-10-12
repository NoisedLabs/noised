/**
 * LM-OTS `LMOTS_SHA256_N32_W4` arithmetic for the whitepaper's figures (RFC 8554 section 4): digits, checksum,
 * verification work, and the exact per-attempt success probability of a forger who has seen several signatures
 * by one key. Pure and self-contained (no imports): the page and the unit tests (app/test/whitepaper-model.test.ts)
 * run the same code.
 *
 * Notation (RFC 8554): n = 32 bytes, w = 4 bits, u = 64 message digits, v = 3 checksum digits, ls = 4,
 * p = u + v = 67 chains of 2^w = 16 positions (0..15).
 */

export const N = 32;
export const W = 4;
export const U = 64;
export const V = 3;
export const LS = 4;
export const P = U + V;
/** Last position on a chain, 2^w - 1. */
export const CHAIN_END = 15;
/** Largest checksum, u * (2^w - 1) = 960. */
export const MAX_CHECKSUM = U * CHAIN_END;
/** C || y[0..p): 32 + 67 * 32 bytes (the typecode is implied by the verifier). */
export const SIG_BYTES = N + P * N;

/** RFC 8554 section 4.1: u = ceil(8n / w), v = ceil((floor(log2(u (2^w - 1))) + 1) / w), ls = 16 - v w. */
export function parameterDerivation(n = N, w = W): { u: number; v: number; ls: number; p: number; maxSum: number } {
  const u = Math.ceil((8 * n) / w);
  const maxSum = u * (2 ** w - 1);
  const v = Math.ceil((Math.floor(Math.log2(maxSum)) + 1) / w);
  const ls = 16 - v * w;
  return { u, v, ls, p: u + v, maxSum };
}

/** The 64 base-16 digits of a 32-byte digest, most significant nibble first (RFC 8554 `coef(Q, i, 4)`). */
export function messageDigits(digest: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    const b = digest[i] ?? 0;
    out.push(b >> 4, b & 15);
  }
  return out;
}

/** Cksm(Q) = sum (2^w - 1 - a_i), before the left shift by ls. */
export function checksum(digits: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < U; i++) s += CHAIN_END - (digits[i] ?? 0);
  return s;
}

/**
 * The three checksum digits: coef(u16str(Cksm << ls), j, 4) for j = 0..2, i.e. the three hex digits of the
 * 12-bit checksum (Cksm <= 960 < 4096).
 */
export function checksumDigits(sum: number): [number, number, number] {
  const shifted = (sum << LS) & 0xffff;
  return [(shifted >> 12) & 15, (shifted >> 8) & 15, (shifted >> 4) & 15];
}

/** All 67 digits (message digits, then checksum digits). */
export function allDigits(digest: ArrayLike<number>): number[] {
  const d = messageDigits(digest);
  return [...d, ...checksumDigits(checksum(d))];
}

/** Chain steps a verifier hashes: sum over the 67 chains of (15 - digit). */
export function verifySteps(digits67: readonly number[]): number {
  let t = 0;
  for (const d of digits67) t += CHAIN_END - d;
  return t;
}

/** Steps a verifier hashes for a digest whose checksum (sum of 15 - a_i over the 64 message digits) is `s`. */
export function stepsForChecksum(s: number): number {
  const [c0, c1, c2] = checksumDigits(s);
  return s + (CHAIN_END - c0) + (CHAIN_END - c1) + (CHAIN_END - c2);
}

/**
 * Exact distribution of the checksum S = sum of 64 independent uniform digits on 0..15 (as 15 - a_i): index s holds
 * Pr[S = s], s = 0..960.
 */
export function checksumDistribution(): Float64Array {
  return sumOfUniforms(new Array<number>(U).fill(CHAIN_END));
}

/** Exact distribution of the verifier's chain steps for a random digest: index t holds Pr[T = t], t = 0..990. */
export function verifyStepsDistribution(): Float64Array {
  const s = checksumDistribution();
  const out = new Float64Array(MAX_CHECKSUM + 3 * CHAIN_END + 1);
  for (let i = 0; i < s.length; i++) out[stepsForChecksum(i)] = (out[stepsForChecksum(i)] ?? 0) + (s[i] ?? 0);
  return out;
}

/**
 * Distribution of a sum of independent uniforms X_i on {0, ..., widths[i]} (index = value), by direct convolution.
 * Every term is non-negative, so even probabilities near 2^-256 keep full relative precision (a running-window sum
 * would subtract nearly equal numbers and lose the far tail, which is exactly what the forgery figure needs).
 */
export function sumOfUniforms(widths: readonly number[]): Float64Array {
  const max = widths.reduce((a, b) => a + b, 0);
  let cur = new Float64Array(max + 1);
  cur[0] = 1;
  let top = 0;
  let next = new Float64Array(max + 1);
  for (const w of widths) {
    if (w === 0) continue;
    const inv = 1 / (w + 1);
    const newTop = top + w;
    next.fill(0, 0, newTop + 1);
    for (let s = 0; s <= top; s++) {
      const p = (cur[s] ?? 0) * inv;
      if (p === 0) continue;
      for (let j = 0; j <= w; j++) next[s + j] = (next[s + j] ?? 0) + p;
    }
    [cur, next] = [next, cur];
    top = newTop;
  }
  return cur;
}

/**
 * log2 of the probability that ONE forgery attempt succeeds, for a forger whose lowest known position on chain i is
 * `m[i]` (67 entries). An attempt picks a message and a randomizer C, computes the digest, and wins if every one of
 * the 67 digits is >= the known minimum (it can then hash forward from the revealed values). The message digits are
 * uniform; given a_i >= m_i each 15 - a_i is uniform on 0..15 - m_i, so the checksum's distribution is exact.
 */
export function log2AttemptSuccess(m: readonly number[]): number {
  let log2Msg = 0;
  const widths: number[] = [];
  for (let i = 0; i < U; i++) {
    const mi = m[i] ?? 0;
    log2Msg += Math.log2((16 - mi) / 16);
    widths.push(CHAIN_END - mi);
  }
  const dist = sumOfUniforms(widths);
  const [n0, n1, n2] = [m[U] ?? 0, m[U + 1] ?? 0, m[U + 2] ?? 0];
  let pCheck = 0;
  for (let s = 0; s < dist.length; s++) {
    const p = dist[s] ?? 0;
    if (p === 0) continue;
    const [c0, c1, c2] = checksumDigits(s);
    if (c0 >= n0 && c1 >= n1 && c2 >= n2) pCheck += p;
  }
  return pCheck > 0 ? log2Msg + Math.log2(pCheck) : Number.NEGATIVE_INFINITY;
}

/** Deterministic PRNG (mulberry32) so every render and every regeneration draws the same samples. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniformly random digest's 67 digits. */
export function randomDigits(rand: () => number): number[] {
  const d: number[] = [];
  for (let i = 0; i < U; i++) d.push(Math.floor(rand() * 16));
  return [...d, ...checksumDigits(checksum(d))];
}

export interface ForgerySample {
  /** Signatures revealed by one key. */
  k: number;
  /** log2 of the expected number of hash evaluations a classical forger needs, one per sampled key. */
  log2Work: number[];
}

/**
 * Classical forgery work 1/Pr[attempt] (log2) for `trials` random keys that each signed `k` independent random
 * digests. k = 1 is exactly 2^256: only the signed digit vector dominates its own minimum (lemma 1).
 */
export function forgeryAt(k: number, trials: number, seed: number): ForgerySample {
  const rand = mulberry32(seed);
  const log2Work: number[] = [];
  for (let t = 0; t < trials; t++) {
    const m = new Array<number>(P).fill(CHAIN_END);
    for (let j = 0; j < k; j++) {
      const d = randomDigits(rand);
      for (let i = 0; i < P; i++) m[i] = Math.min(m[i] ?? CHAIN_END, d[i] ?? 0);
    }
    log2Work.push(-log2AttemptSuccess(m));
  }
  return { k, log2Work };
}

/** forgeryAt for k = 1..kMax (one seed per k). */
export function forgerySweep(kMax: number, trials: number, seed: number): ForgerySample[] {
  const out: ForgerySample[] = [];
  for (let k = 1; k <= kMax; k++) out.push(forgeryAt(k, trials, seed + k));
  return out;
}

/** The q-quantile (0..1) of a sample, by linear interpolation between order statistics. */
export function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] ?? Number.NaN;
  const b = s[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/**
 * Grover-style search for a success predicate of probability rho needs about (pi / 4) / sqrt(rho) iterations: the
 * quantum attacker's work in log2 is roughly half the classical one (minus 0.35).
 */
export function quantumLog2(classicalLog2: number): number {
  return classicalLog2 / 2 + Math.log2(Math.PI / 4);
}

/**
 * LM-OTS one-time signatures (RFC 8554 section 4, NIST SP 800-208), parameter
 * set LMOTS_SHA256_N32_W4 — TypeScript twin of `crates/noised-lmots`.
 *
 * Byte-for-byte compatible with the on-chain vault verifier and checked
 * against RFC 8554 Appendix F, Test Case 2 (`test/vectors/rfc8554_tc2.json`).
 *
 * A key signs exactly one message, ever. If a transaction is dropped,
 * re-broadcast the same signature; never sign a different message.
 *
 * INTERNAL module: `sign` and `signDeterministic` record nothing, so they are
 * not exported from the package root or any `exports` path (the public
 * `lmots` namespace is `./lmotsPublic.ts`). Their only callers are the vault
 * signer behind the vault-key ledger (`./vault.ts`) and the LMS signer behind
 * the leaf ledger (`./lms.ts`), plus the RFC 8554 / Rust known-answer tests.
 *
 * The randomizer `C` is deterministic and secret-keyed, as in the crate's
 * `PrivateKey::randomizer` / `sign_deterministic`:
 * `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32be(q) || message)`
 * (the construction FIPS 205 uses for SLH-DSA's `PRF_msg`). Nobody without
 * `SEED` can predict it, and signing the same message again reproduces the
 * same signature, so a retry can never become a second one-time signature.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const TYPECODE = 3;
export const N = 32;
export const W = 4;
export const P = 67;
export const LS = 4;
export const CHAIN_END = 15;
export const ID_LEN = 16;
/** `C || y[0..67]`; the typecode is fixed by the verifier and not transmitted. */
export const SIG_LEN = N + P * N;
/** u32str(type) || I || u32str(q) || K */
export const PUBLIC_KEY_LEN = 4 + ID_LEN + 4 + N;

// protocol constant: kept from the original name; changing it changes signatures
/** Domain tag of the deterministic randomizer (`noised_lmots::RANDOMIZER_TAG`). */
export const RANDOMIZER_TAG = new TextEncoder().encode("phalanx/pq/lmots/C");

const D_PBLC = Uint8Array.of(0x80, 0x80);
const D_MESG = Uint8Array.of(0x81, 0x81);
const DOMAIN_KEY_ID = 0x20;

export interface LmotsPublicKey {
  /** Key identifier `I` (16 bytes). */
  readonly id: Uint8Array;
  /** Leaf index `q` (u32). */
  readonly q: number;
  /** Public key hash `K` (32 bytes). */
  readonly k: Uint8Array;
}

export interface LmotsPrivateKey {
  readonly id: Uint8Array;
  readonly q: number;
  /** 32-byte seed for RFC 8554 Appendix A chain secrets. */
  readonly seed: Uint8Array;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError("u32 out of range");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
}

function u16be(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, false);
  return b;
}

function checkLen(name: string, b: Uint8Array, len: number): void {
  if (b.length !== len) throw new RangeError(`${name} must be ${len} bytes, got ${b.length}`);
}

/** RFC 8554 encoding: u32str(type) || I || u32str(q) || K. */
export function publicKeyBytes(pk: LmotsPublicKey): Uint8Array {
  checkLen("id", pk.id, ID_LEN);
  checkLen("k", pk.k, N);
  return concat([u32be(TYPECODE), pk.id, u32be(pk.q), pk.k]);
}

/** Stable 32-byte identifier of a public key (the vault PDA seed). */
export function keyId(pk: LmotsPublicKey): Uint8Array {
  return sha256(concat([Uint8Array.of(DOMAIN_KEY_ID), publicKeyBytes(pk)]));
}

function checksum(q: Uint8Array): number {
  let sum = 0;
  for (const byte of q) sum += CHAIN_END - (byte >> 4) + (CHAIN_END - (byte & 0x0f));
  return (sum << LS) & 0xffff;
}

/** `Q || Cksm(Q)` */
function digest(id: Uint8Array, q: number, c: Uint8Array, msg: Uint8Array): Uint8Array {
  const qHash = sha256(concat([id, u32be(q), D_MESG, c, msg]));
  return concat([qHash, u16be(checksum(qHash))]);
}

function coef(v: Uint8Array, i: number): number {
  const byte = v[i >> 1]!;
  return i % 2 === 0 ? byte >> 4 : byte & 0x0f;
}

/**
 * Chain steps `start..end` of chain `i` from `value`. The working buffer and
 * every intermediate hash are wiped (audit 4, ID-F7: below the chain end
 * they are secret chain values); only the result survives.
 */
function walk(id: Uint8Array, q: number, i: number, start: number, end: number, value: Uint8Array): Uint8Array {
  const buf = new Uint8Array(ID_LEN + 4 + 2 + 1 + N);
  try {
    buf.set(id, 0);
    buf.set(u32be(q), 16);
    buf.set(u16be(i), 20);
    buf.set(value, 23);
    for (let j = start; j < end; j++) {
      buf[22] = j;
      const h = sha256(buf);
      buf.set(h, 23);
      h.fill(0);
    }
    return buf.slice(23, 55);
  } finally {
    buf.fill(0);
  }
}

/** RFC 8554 Algorithm 4b: the `K` a signature implies, or null on bad length. */
export function candidatePublicKey(id: Uint8Array, q: number, msg: Uint8Array, sig: Uint8Array): Uint8Array | null {
  checkLen("id", id, ID_LEN);
  if (sig.length !== SIG_LEN) return null;
  const c = sig.subarray(0, N);
  const v = digest(id, q, c, msg);
  const z = new Uint8Array(P * N);
  for (let i = 0; i < P; i++) {
    z.set(walk(id, q, i, coef(v, i), CHAIN_END, sig.subarray(N + i * N, N + (i + 1) * N)), i * N);
  }
  return sha256(concat([id, u32be(q), D_PBLC, z]));
}

/** Verify exactly as the on-chain program does. */
export function verify(pk: LmotsPublicKey, msg: Uint8Array, sig: Uint8Array): boolean {
  const k = candidatePublicKey(pk.id, pk.q, msg, sig);
  if (k === null) return false;
  let diff = 0;
  for (let i = 0; i < N; i++) diff |= k[i]! ^ pk.k[i]!;
  return diff === 0;
}

/** RFC 8554 Appendix A: chain `i`'s secret `x[i]`. The concatenation (it holds `SEED`) is wiped (audit 4, ID-F7). */
function secret(sk: LmotsPrivateKey, i: number): Uint8Array {
  const buf = concat([sk.id, u32be(sk.q), u16be(i), Uint8Array.of(0xff), sk.seed]);
  try {
    return sha256(buf);
  } finally {
    buf.fill(0);
  }
}

/** `walk` from chain `i`'s secret, wiping the secret after use. */
function walkFromSecret(sk: LmotsPrivateKey, i: number, end: number): Uint8Array {
  const x = secret(sk, i);
  try {
    return walk(sk.id, sk.q, i, 0, end, x);
  } finally {
    x.fill(0);
  }
}

/** RFC 8554 Algorithm 1 (with Appendix A secrets). */
export function publicKey(sk: LmotsPrivateKey): LmotsPublicKey {
  checkLen("id", sk.id, ID_LEN);
  checkLen("seed", sk.seed, N);
  const y = new Uint8Array(P * N);
  for (let i = 0; i < P; i++) y.set(walkFromSecret(sk, i, CHAIN_END), i * N);
  return { id: Uint8Array.from(sk.id), q: sk.q, k: sha256(concat([sk.id, u32be(sk.q), D_PBLC, y])) };
}

/** HMAC-SHA256 (RFC 2104) of the concatenation of `parts` (`noised_lmots::hmac_sha256`). */
export function hmacSha256(key: Uint8Array, parts: readonly Uint8Array[]): Uint8Array {
  const mac = hmac.create(sha256, key);
  for (const p of parts) mac.update(p);
  return mac.digest();
}

/**
 * Deterministic, secret-keyed randomizer for `msg`:
 * `HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32be(q) || msg)`.
 */
export function randomizer(sk: LmotsPrivateKey, msg: Uint8Array): Uint8Array {
  checkLen("id", sk.id, ID_LEN);
  checkLen("seed", sk.seed, N);
  return hmacSha256(sk.seed, [RANDOMIZER_TAG, sk.id, u32be(sk.q), msg]);
}

/**
 * INTERNAL (not exported from the package): RFC 8554 Algorithm 3 with a
 * caller-supplied randomizer `c`. Two different `c` for one message are two
 * signatures, and it records nothing: callers must reserve the key in a
 * durable ledger first.
 */
export function sign(sk: LmotsPrivateKey, msg: Uint8Array, c: Uint8Array): Uint8Array {
  checkLen("id", sk.id, ID_LEN);
  checkLen("seed", sk.seed, N);
  checkLen("c", c, N);
  const v = digest(sk.id, sk.q, c, msg);
  const out = new Uint8Array(SIG_LEN);
  out.set(c, 0);
  for (let i = 0; i < P; i++) {
    const y = walkFromSecret(sk, i, coef(v, i));
    out.set(y, N + i * N);
    y.fill(0);
  }
  return out;
}

/**
 * INTERNAL (not exported from the package): `sign` with `randomizer(sk, msg)`,
 * so the same message always yields the identical signature. It records
 * nothing; the vault signer calls it only after the vault-key ledger
 * reserved the key for this message.
 */
export function signDeterministic(sk: LmotsPrivateKey, msg: Uint8Array): Uint8Array {
  return sign(sk, msg, randomizer(sk, msg));
}

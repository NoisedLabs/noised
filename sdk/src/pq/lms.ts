/**
 * LMS hash-based signatures (RFC 8554 section 5), parameter set
 * `LMS_SHA256_M32_H10` (typecode 6) over `LMOTS_SHA256_N32_W4` (typecode 3) —
 * TypeScript twin of `crates/noised-lmots/src/lms.rs`: one 56-byte public
 * key for 1,024 one-time leaves. A Noised creator identity is one LMS key;
 * on-chain it is named by `identityId(pk) = SHA256(0x21 || pk)`.
 *
 * Byte for byte compatible with the launchpad's verifier: checked against
 * RFC 8554 Appendix F Test Case 2 (its top-level tree is this parameter set)
 * and every LMS value of `tests/integration/vectors/lms.json`
 * (`test/lms.test.ts`).
 *
 * ```text
 * public key = u32str(6) || u32str(3) || I (16) || T[1] (32)                      56 bytes
 * signature  = u32str(q) || u32str(3) || C (32) || y[0] .. y[66] (67 * 32)
 *              || u32str(6) || path[0] .. path[9] (10 * 32)                      2,508 bytes
 *   offsets:   q 0..4 | LM-OTS type 4..8 | C 8..40 | y 40..2184 | LMS type 2184..2188 | path 2188..2508
 * leaf       T[r] = SHA256(I || u32str(r) || 0x8282 || K_q)                  r = 1024 + q
 * interior   T[r] = SHA256(I || u32str(r) || 0x8383 || T[2r] || T[2r+1])   1 <= r < 1024
 * identity   identityId = SHA256(0x21 || public key)
 * ```
 *
 * `K_q` is the LM-OTS public key hash of leaf `q`: the LM-OTS key
 * `{ id: I, q, seed: SEED }` (RFC 8554 Appendix A secrets, `./lmots.ts`).
 *
 * # One message per leaf, ever
 *
 * LMS is stateful. Two signatures of different messages (or of one message
 * under two randomizers) from the same leaf reveal enough Winternitz chain
 * values for anyone to forge signatures from that leaf. The launchpad's
 * on-chain bitmap records only the leaves whose signatures LANDED; a
 * signature that was revealed (sent, simulated, stored in a failed
 * transaction) but never landed still uses its leaf. So:
 *
 * - reserve a leaf for exactly one message in a durable record BEFORE any
 *   signature bytes exist (`./leafLedger.ts`, `reserveAndSign`), and never
 *   sign a second message at it;
 * - sign with the deterministic randomizer
 *   `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32str(q) || msg)`:
 *   a retry reproduces the identical bytes, so re-broadcasting is never a
 *   second signature.
 *
 * So `LmsKeyPair` has no signing method. The only exported ways to sign are
 * `leafLedger.reserveAndSign` and `leafLedger.signAtNextLeaf` (and
 * `buildAttestLaunchTx` on top of them), which record the leaf first.
 * `signLeafDeterministic` (what the ledger calls) and
 * `signLeafWithRandomizer` (a caller-chosen `C`, for the RFC 8554 known
 * answers only) are internal to the SDK: the package's public `lms`
 * namespace (`./lmsPublic.ts`) does not export them.
 *
 * Every signature is verified against the key pair's own public key before
 * it is returned; a key pair whose tree does not belong to its secret (a
 * corrupted cache) releases nothing.
 *
 * # Key generation
 *
 * A key generation is about 1.14 million SHA-256 compressions (1,024 leaves
 * x 67 chains x 16 one-block hashes, plus the 1,024 `K` hashes and the
 * tree). Calling a general-purpose SHA-256 per hash costs ~2.8 s in Node
 * (allocation and padding per call); `lmsKeygen` runs a specialized
 * allocation-free compression instead (every Appendix A secret and chain
 * step is one 55-byte block whose first 20 bytes, `I || u32str(q)`, are
 * constant per leaf, so the state after rounds 0..4 is computed once per
 * leaf; ~0.55 s for the 1.14 million compressions in Node 22 on a Ryzen 7
 * 5800X). It is checked against `./lmots.ts` leaf by leaf and against the
 * Rust tree as a whole (`nodesSha256`). The async `lmsKeygen` works in
 * time slices (`sliceMs`, default 12 ms), reports progress and yields to
 * the event loop between slices, so a browser stays responsive without a
 * Web Worker. `lmsKeygenSync` is the same work in one call (for workers).
 *
 * The 2,047 tree nodes are public (they appear in authentication paths).
 * `exportTreeCache` / `lmsKeyPairFromTreeCache` store them (65,536 bytes
 * with their tag) so later sessions sign in milliseconds; the tag is an
 * HMAC under `SEED`, so a cache written by anyone without the secret is
 * refused (a forged tree would name a forged public key, whose empty
 * on-chain bitmap could lead a client to reuse a leaf of the real key).
 *
 * # Secrets
 *
 * `SEED` is copied into the key pair and wiped by `LmsKeyPair.wipe()`;
 * key generation wipes its working state (the chain values below the chain
 * ends) after every leaf. JavaScript cannot guarantee that no other copy of
 * a secret survives (garbage-collected intermediates of SHA-256 and HMAC),
 * so wiping is best effort.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import { bytesEqual, isAllZero, isUint, toHex, utf8 } from "../codec/bytes.js";
import * as lmots from "./lmots.js";

/** RFC 8554 typecode of `LMS_SHA256_M32_H10`. */
export const LMS_TYPE = 6;
/** LM-OTS typecode of the leaves (`LMOTS_SHA256_N32_W4`). */
export const LMS_OTS_TYPE = lmots.TYPECODE;
/** Tree height `h`. */
export const LMS_HEIGHT = 10;
/** One-time leaves per key (2^h). */
export const LMS_LEAVES = 1 << LMS_HEIGHT;
/** Nodes `T[1] .. T[2^(h+1) - 1]` of the tree. */
export const LMS_TREE_NODES = 2 * LMS_LEAVES - 1;
/** `u32str(type) || u32str(otstype) || I || T[1]`. */
export const LMS_PUBLIC_KEY_LEN = 4 + 4 + lmots.ID_LEN + lmots.N;
/** `u32str(q) || u32str(otstype) || C || y || u32str(type) || path`. */
export const LMS_SIGNATURE_LEN = 4 + 4 + lmots.SIG_LEN + 4 + LMS_HEIGHT * lmots.N;
/** Byte offsets inside a signature. */
export const LMS_SIGNATURE_OFFSETS = { q: 0, otsType: 4, c: 8, y: 40, lmsType: 2184, path: 2188 } as const;
/** Leaf-node hash tag. */
export const D_LEAF = Uint8Array.of(0x82, 0x82);
/** Interior-node hash tag. */
export const D_INTR = Uint8Array.of(0x83, 0x83);
/** Domain byte of `identityId` (0x20 is the vault's LM-OTS `keyId`). */
export const DOMAIN_IDENTITY_ID = 0x21;
// protocol constants (tree-cache, leaf-probe and probe-key tags): kept from the original name; changing them changes leaf choices and invalidates every tree cache
/** Domain tag of the tree cache's HMAC (client-side only; never on-chain). */
export const TREE_CACHE_TAG = utf8("phalanx/pq/lms/v1/tree-cache");
/** Domain tag of the secret leaf probe v2 (audit 4, ID-F1a; client-side only). */
export const LEAF_PROBE_V2_TAG = utf8("phalanx/pq/identity/leaf/v2");
/** Domain tag of the probe key, `HMAC-SHA256(SEED, tag || I)`. */
export const LEAF_PROBE_KEY_TAG = utf8("phalanx/pq/identity/leaf/v2/key");

/**
 * The secret probe key of an LMS key: `HMAC-SHA256(SEED, LEAF_PROBE_KEY_TAG
 * || I)`. Internal (not exported from the package): only the identity's
 * `SEED` gives it, so nobody else can predict where a message's leaf probe
 * starts.
 */
export function leafProbeKey(sk: LmsPrivateKey): Uint8Array {
  checkLen("SEED", sk.seed, N);
  checkLen("I", sk.id, ID_LEN);
  return lmots.hmacSha256(sk.seed, [LEAF_PROBE_KEY_TAG, sk.id]);
}

/**
 * Where the secret leaf probe v2 starts for `message` (audit 4, ID-F1a):
 * `u16be(HMAC-SHA256(probeKey, "phalanx/pq/identity/leaf/v2" || message)[0..2])
 * mod 1024`. Deterministic per message (a retry finds the same leaf) and
 * unpredictable without the key (`leafProbeKey`).
 */
export function secretLeafProbeStart(probeKey: Uint8Array, message: Uint8Array): number {
  checkLen("probe key", probeKey, N);
  if (!(message instanceof Uint8Array)) throw new TypeError("message must be a Uint8Array");
  const h = lmots.hmacSha256(probeKey, [LEAF_PROBE_V2_TAG, message]);
  return ((h[0]! << 8) | h[1]!) % LMS_LEAVES;
}
/** `T[1] || .. || T[2047] || HMAC-SHA256(SEED, TREE_CACHE_TAG || I || nodes)`. */
export const TREE_CACHE_LEN = LMS_TREE_NODES * lmots.N + 32;

const N = lmots.N;
const ID_LEN = lmots.ID_LEN;
const P = lmots.P;
const PATH_LEN = LMS_HEIGHT * N;
const D_PBLC = Uint8Array.of(0x80, 0x80);

function checkLen(name: string, b: unknown, len: number): asserts b is Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (b.length !== len) throw new RangeError(`${name} must be ${len} bytes, got ${b.length}`);
}

function checkLeaf(q: unknown): asserts q is number {
  if (!isUint(q, LMS_LEAVES - 1)) throw new RangeError(`leaf must be an integer in 0..${LMS_LEAVES - 1}, got ${String(q)}`);
}

function be32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function putBe32(b: Uint8Array, at: number, v: number): void {
  b[at] = v >>> 24;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

// ------------------------------------------------------------ public key ---

/** A parsed LMS public key of this parameter set. */
export interface LmsPublicKey {
  /** Key identifier `I` (16 bytes). */
  readonly id: Uint8Array;
  /** Root `T[1]` (32 bytes). */
  readonly root: Uint8Array;
}

/**
 * Strict parse: exactly 56 bytes with typecodes 6 (`LMS_SHA256_M32_H10`) and
 * 3 (`LMOTS_SHA256_N32_W4`); anything else is `null`.
 */
export function parseLmsPublicKey(bytes: Uint8Array): LmsPublicKey | null {
  if (!(bytes instanceof Uint8Array) || bytes.length !== LMS_PUBLIC_KEY_LEN) return null;
  if (be32(bytes, 0) !== LMS_TYPE || be32(bytes, 4) !== LMS_OTS_TYPE) return null;
  return { id: bytes.slice(8, 8 + ID_LEN), root: bytes.slice(8 + ID_LEN) };
}

/** RFC 8554 encoding: `u32str(6) || u32str(3) || I || T[1]`. */
export function encodeLmsPublicKey(pk: LmsPublicKey): Uint8Array {
  checkLen("id", pk.id, ID_LEN);
  checkLen("root", pk.root, N);
  const out = new Uint8Array(LMS_PUBLIC_KEY_LEN);
  putBe32(out, 0, LMS_TYPE);
  putBe32(out, 4, LMS_OTS_TYPE);
  out.set(pk.id, 8);
  out.set(pk.root, 8 + ID_LEN);
  return out;
}

/**
 * Stable 32-byte name of an LMS public key: `SHA256(0x21 || pk)`. This is a
 * launch's `pq_identity` and the seed of its `["identity", id]` account.
 * Throws unless `pk` is 56 bytes (it does not check the typecodes: the
 * program hashes whatever key it is sent).
 */
export function identityId(publicKey: Uint8Array): Uint8Array {
  checkLen("LMS public key", publicKey, LMS_PUBLIC_KEY_LEN);
  const buf = new Uint8Array(1 + LMS_PUBLIC_KEY_LEN);
  buf[0] = DOMAIN_IDENTITY_ID;
  buf.set(publicKey, 1);
  return sha256(buf);
}

// ------------------------------------------------------------- signature ---

/** A parsed LMS signature (views into the input bytes). */
export interface ParsedLmsSignature {
  /** Leaf index `q` (< 1024). */
  readonly q: number;
  /** `C || y[0] || ... || y[66]` (2,176 bytes): the LM-OTS signature without its typecode. */
  readonly otsSignature: Uint8Array;
  /** `path[0] || ... || path[9]` (320 bytes), from the leaf's sibling up. */
  readonly path: Uint8Array;
}

/**
 * Strict parse: exactly 2,508 bytes, LM-OTS typecode 3 at 4..8, LMS typecode
 * 6 at 2184..2188 and `q < 1024`; anything else is `null`.
 */
export function parseLmsSignature(sig: Uint8Array): ParsedLmsSignature | null {
  if (!(sig instanceof Uint8Array) || sig.length !== LMS_SIGNATURE_LEN) return null;
  const o = LMS_SIGNATURE_OFFSETS;
  if (be32(sig, o.otsType) !== LMS_OTS_TYPE || be32(sig, o.lmsType) !== LMS_TYPE) return null;
  const q = be32(sig, o.q);
  if (q >= LMS_LEAVES) return null;
  return { q, otsSignature: sig.subarray(o.c, o.lmsType), path: sig.subarray(o.path) };
}

/** RFC 8554 Algorithm 6a step 4: the root implied by leaf `q`'s LM-OTS key hash `kc` and its path. */
function rootFromPath(id: Uint8Array, q: number, kc: Uint8Array, path: Uint8Array): Uint8Array {
  let node = LMS_LEAVES + q;
  const leaf = new Uint8Array(ID_LEN + 4 + 2 + N);
  leaf.set(id, 0);
  putBe32(leaf, ID_LEN, node);
  leaf.set(D_LEAF, ID_LEN + 4);
  leaf.set(kc, ID_LEN + 6);
  let tmp = sha256(leaf);
  const inner = new Uint8Array(ID_LEN + 4 + 2 + 2 * N);
  inner.set(id, 0);
  inner.set(D_INTR, ID_LEN + 4);
  for (let i = 0; i < LMS_HEIGHT; i++) {
    const sibling = path.subarray(i * N, (i + 1) * N);
    putBe32(inner, ID_LEN, node >>> 1);
    if (node % 2 === 0) {
      inner.set(tmp, ID_LEN + 6);
      inner.set(sibling, ID_LEN + 6 + N);
    } else {
      inner.set(sibling, ID_LEN + 6);
      inner.set(tmp, ID_LEN + 6 + N);
    }
    tmp = sha256(inner);
    node >>>= 1;
  }
  return tmp;
}

/**
 * Verify an LMS signature exactly as the launchpad does (RFC 8554 Algorithms
 * 6 and 6a, `noised_lmots::lms_verify`) and return the leaf `q` it used, or
 * `null` if the key or signature is malformed (see `parseLmsPublicKey` and
 * `parseLmsSignature`) or does not verify. The root is compared in constant
 * time. The leaf comes from the signature only: no function takes a separate
 * leaf index, so a caller cannot record one leaf while the signature used
 * another.
 */
export function lmsVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): number | null {
  const pk = parseLmsPublicKey(publicKey);
  if (pk === null) return null;
  const sig = parseLmsSignature(signature);
  if (sig === null) return null;
  if (!(message instanceof Uint8Array)) return null;
  const kc = lmots.candidatePublicKey(pk.id, sig.q, message, sig.otsSignature);
  if (kc === null) return null;
  return bytesEqual(rootFromPath(pk.id, sig.q, kc, sig.path), pk.root) ? sig.q : null;
}

// ------------------------------------- SHA-256 core for key generation ---
//
// FIPS 180-4 SHA-256 compression on Int32 words, for the one-block (55-byte)
// hashes of RFC 8554 Algorithm 1: the Appendix A secret
// `I || u32str(q) || u16str(i) || 0xff || SEED` and the chain step
// `I || u32str(q) || u16str(i) || u8str(j) || tmp`. Words 0..4 hold
// `I || u32str(q)` (constant per leaf), so the state after rounds 0..4 is
// computed once per leaf (`midstate`); word 5 is `u16str(i) || j || tmp[0]`,
// words 6..12 the rest of `tmp` shifted by one byte, word 13 its last three
// bytes and the 0x80 pad, word 15 the bit length 440. Module state is safe to
// share: each leaf is computed synchronously, start to end, and wiped after.

const K256 = Int32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);
const IV256 = Int32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
const W = new Int32Array(64);
const MID = new Int32Array(8);
const OUT = new Int32Array(8);
/** Big-endian words of `SEED` while a leaf is being computed. */
const SEED_WORDS = new Int32Array(8);
/** The message length of every one-block hash here, in bits (55 * 8). */
const ONE_BLOCK_BITS = 440;

/** Rounds 0..4 over `W[0..5]` (`I || u32str(q)`) from the IV -> `MID`. */
function midstate(): void {
  let a = IV256[0]!, b = IV256[1]!, c = IV256[2]!, d = IV256[3]!, e = IV256[4]!, f = IV256[5]!, g = IV256[6]!, h = IV256[7]!;
  for (let t = 0; t < 5; t++) {
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K256[t]! + W[t]!) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  MID[0] = a;
  MID[1] = b;
  MID[2] = c;
  MID[3] = d;
  MID[4] = e;
  MID[5] = f;
  MID[6] = g;
  MID[7] = h;
}

/** Rounds 5..63 from `MID` over `W[0..16]` (schedule on the fly), then the feed-forward -> `OUT`. */
function compressFromMid(): void {
  let a = MID[0]!, b = MID[1]!, c = MID[2]!, d = MID[3]!, e = MID[4]!, f = MID[5]!, g = MID[6]!, h = MID[7]!;
  for (let t = 5; t < 64; t++) {
    let w: number;
    if (t < 16) {
      w = W[t]!;
    } else {
      const w15 = W[t - 15]!;
      const w2 = W[t - 2]!;
      w = (W[t - 16]! + (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) + W[t - 7]! + (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10))) | 0;
      W[t] = w;
    }
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K256[t]! + w) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  OUT[0] = (IV256[0]! + a) | 0;
  OUT[1] = (IV256[1]! + b) | 0;
  OUT[2] = (IV256[2]! + c) | 0;
  OUT[3] = (IV256[3]! + d) | 0;
  OUT[4] = (IV256[4]! + e) | 0;
  OUT[5] = (IV256[5]! + f) | 0;
  OUT[6] = (IV256[6]! + g) | 0;
  OUT[7] = (IV256[7]! + h) | 0;
}

/** Words 5..13 of the block `u16str(i) || j || src[0..32] || 0x80` (src = 8 big-endian words). */
function loadStep(i: number, j: number, src: Int32Array): void {
  W[5] = (i << 16) | (j << 8) | (src[0]! >>> 24);
  W[6] = (src[0]! << 8) | (src[1]! >>> 24);
  W[7] = (src[1]! << 8) | (src[2]! >>> 24);
  W[8] = (src[2]! << 8) | (src[3]! >>> 24);
  W[9] = (src[3]! << 8) | (src[4]! >>> 24);
  W[10] = (src[4]! << 8) | (src[5]! >>> 24);
  W[11] = (src[5]! << 8) | (src[6]! >>> 24);
  W[12] = (src[6]! << 8) | (src[7]! >>> 24);
  W[13] = (src[7]! << 8) | 0x80;
}

function wipeCore(): void {
  W.fill(0);
  MID.fill(0);
  OUT.fill(0);
  SEED_WORDS.fill(0);
}

/**
 * `K_q`, the LM-OTS public key hash of leaf `q` (RFC 8554 Algorithm 1 with
 * Appendix A secrets): identical to `lmots.publicKey({id, q, seed}).k`.
 * `kbuf` is a 2,166-byte scratch buffer for `I || u32str(q) || 0x8080 || y`.
 */
function leafKeyHash(idWords: Int32Array, id: Uint8Array, seed: Uint8Array, q: number, kbuf: Uint8Array): Uint8Array {
  try {
    for (let k = 0; k < 8; k++) SEED_WORDS[k] = (seed[4 * k]! << 24) | (seed[4 * k + 1]! << 16) | (seed[4 * k + 2]! << 8) | seed[4 * k + 3]!;
    W[0] = idWords[0]!;
    W[1] = idWords[1]!;
    W[2] = idWords[2]!;
    W[3] = idWords[3]!;
    W[4] = q | 0;
    W[14] = 0;
    W[15] = ONE_BLOCK_BITS;
    midstate();
    kbuf.set(id, 0);
    putBe32(kbuf, ID_LEN, q);
    kbuf.set(D_PBLC, ID_LEN + 4);
    for (let i = 0; i < P; i++) {
      // x[i] = SHA256(I || u32str(q) || u16str(i) || 0xff || SEED)
      loadStep(i, 0xff, SEED_WORDS);
      compressFromMid();
      // y[i] = 15 chain steps from x[i]
      for (let j = 0; j < lmots.CHAIN_END; j++) {
        loadStep(i, j, OUT);
        compressFromMid();
      }
      const at = ID_LEN + 6 + i * N;
      for (let k = 0; k < 8; k++) putBe32(kbuf, at + 4 * k, OUT[k]!);
    }
    return sha256(kbuf);
  } finally {
    wipeCore();
  }
}

// --------------------------------------------------------------- tree ---

/** `T[r]` for 1 <= r < 2048 at offset `r * 32` (offset 0 unused). */
function buildTree(id: Uint8Array, leafKeys: Uint8Array): Uint8Array {
  const nodes = new Uint8Array(2 * LMS_LEAVES * N);
  const leaf = new Uint8Array(ID_LEN + 4 + 2 + N);
  leaf.set(id, 0);
  leaf.set(D_LEAF, ID_LEN + 4);
  for (let q = 0; q < LMS_LEAVES; q++) {
    const r = LMS_LEAVES + q;
    putBe32(leaf, ID_LEN, r);
    leaf.set(leafKeys.subarray(q * N, (q + 1) * N), ID_LEN + 6);
    nodes.set(sha256(leaf), r * N);
  }
  fillInterior(id, nodes);
  return nodes;
}

function interiorNode(inner: Uint8Array, nodes: Uint8Array, r: number): Uint8Array {
  putBe32(inner, ID_LEN, r);
  inner.set(nodes.subarray(2 * r * N, (2 * r + 2) * N), ID_LEN + 6);
  return sha256(inner);
}

function interiorBuffer(id: Uint8Array): Uint8Array {
  const inner = new Uint8Array(ID_LEN + 4 + 2 + 2 * N);
  inner.set(id, 0);
  inner.set(D_INTR, ID_LEN + 4);
  return inner;
}

function fillInterior(id: Uint8Array, nodes: Uint8Array): void {
  const inner = interiorBuffer(id);
  for (let r = LMS_LEAVES - 1; r >= 1; r--) nodes.set(interiorNode(inner, nodes, r), r * N);
}

// ------------------------------------------------------------- key pair ---

/** LMS private key: `SEED` (32 bytes) and `I` (16 bytes). Leaf `q` is the LM-OTS key `{ id: I, q, seed: SEED }`. */
export interface LmsPrivateKey {
  readonly seed: Uint8Array;
  readonly id: Uint8Array;
}

function checkPrivateKey(sk: LmsPrivateKey): void {
  checkLen("SEED", sk.seed, N);
  checkLen("I", sk.id, ID_LEN);
  if (isAllZero(sk.seed)) {
    throw new RangeError("refusing an all-zero LMS SEED: no derivation produces it (was it wiped?), and every key from it is public");
  }
}

/** Set by `LmsKeyPair`'s static block: the one function that reaches a key pair's secret to sign. */
let signWithKeyPair: (kp: LmsKeyPair, q: number, message: Uint8Array, c: Uint8Array | null) => Uint8Array;

/**
 * An LMS private key with its tree. Built by `lmsKeygen`, `lmsKeygenSync` or
 * `lmsKeyPairFromTreeCache`. It has no public signing method: sign through
 * the leaf ledger (`leafLedger.reserveAndSign` / `signAtNextLeaf`), which
 * reserves the leaf for the message durably before any signature exists.
 */
export class LmsKeyPair {
  readonly #seed: Uint8Array;
  readonly #id: Uint8Array;
  /** `T[r]` at offset `r * 32` for 1 <= r < 2048. */
  readonly #nodes: Uint8Array;
  #wiped = false;

  /** @internal Use `lmsKeygen`, `lmsKeygenSync` or `lmsKeyPairFromTreeCache`. */
  constructor(sk: LmsPrivateKey, nodes: Uint8Array, token: symbol) {
    if (token !== CONSTRUCT) throw new TypeError("use lmsKeygen, lmsKeygenSync or lmsKeyPairFromTreeCache");
    this.#seed = Uint8Array.from(sk.seed);
    this.#id = Uint8Array.from(sk.id);
    this.#nodes = nodes;
  }

  /** Key identifier `I` (16 bytes; public). */
  get id(): Uint8Array {
    return this.#id.slice();
  }

  /** Root `T[1]` (32 bytes). */
  get root(): Uint8Array {
    return this.#nodes.slice(N, 2 * N);
  }

  /** The 56-byte public key `u32str(6) || u32str(3) || I || T[1]`. */
  get publicKey(): Uint8Array {
    return encodeLmsPublicKey({ id: this.#id, root: this.#nodes.subarray(N, 2 * N) });
  }

  /** `identityId(publicKey)`: the launch's `pq_identity` and the identity account seed. */
  get identityId(): Uint8Array {
    return identityId(this.publicKey);
  }

  /** True once `wipe()` ran: the key pair can no longer sign. */
  get wiped(): boolean {
    return this.#wiped;
  }

  /** `T[r]` for 1 <= r <= 2047 (leaf `q` is `T[1024 + q]`). */
  node(r: number): Uint8Array {
    if (!isUint(r, LMS_TREE_NODES) || r === 0) throw new RangeError(`node index must be in 1..${LMS_TREE_NODES}`);
    return this.#nodes.slice(r * N, (r + 1) * N);
  }

  /** The 2,047 node hashes `T[1] || .. || T[2047]` (65,504 bytes; public). */
  nodes(): Uint8Array {
    return this.#nodes.slice(N);
  }

  /** Authentication path of leaf `q` (RFC 8554 Appendix D): `path[i] = T[((1024 + q) >> i) xor 1]`, 320 bytes. */
  authPath(q: number): Uint8Array {
    checkLeaf(q);
    const path = new Uint8Array(PATH_LEN);
    let r = LMS_LEAVES + q;
    for (let i = 0; i < LMS_HEIGHT; i++) {
      const s = r ^ 1;
      path.set(this.#nodes.subarray(s * N, (s + 1) * N), i * N);
      r >>>= 1;
    }
    return path;
  }

  #leafKey(q: number): lmots.LmotsPrivateKey {
    if (this.#wiped) throw new Error("this LMS key pair was wiped: derive it again to sign");
    checkLeaf(q);
    return { id: this.#id, q, seed: this.#seed };
  }

  /**
   * Leaf `q`'s deterministic randomizer
   * `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32str(q) || message)`.
   */
  randomizer(q: number, message: Uint8Array): Uint8Array {
    return lmots.randomizer(this.#leafKey(q), message);
  }

  #probeKey: Uint8Array | null = null;

  /**
   * Where `message`'s leaf probe starts (the secret probe v2, audit 4,
   * ID-F1a): `u16be(HMAC-SHA256(probeKey, "phalanx/pq/identity/leaf/v2" ||
   * message)[0..2]) mod 1024` with `probeKey = HMAC-SHA256(SEED,
   * "phalanx/pq/identity/leaf/v2/key" || I)`. Nobody without `SEED` can
   * predict it, so nobody can steer a message onto a chosen leaf.
   */
  leafProbeStart(message: Uint8Array): number {
    if (this.#wiped) throw new Error("this LMS key pair was wiped: derive it again");
    this.#probeKey ??= leafProbeKey({ seed: this.#seed, id: this.#id });
    return secretLeafProbeStart(this.#probeKey, message);
  }

  static {
    signWithKeyPair = (kp, q, message, c) => kp.#sign(q, message, c);
  }

  /**
   * RFC 8554 section 5.4.1 at leaf `q`, with the randomizer `c` or (null) the
   * deterministic one. Throws (releasing nothing) if the result does not
   * verify against this key pair's public key.
   */
  #sign(q: number, message: Uint8Array, c: Uint8Array | null): Uint8Array {
    const leaf = this.#leafKey(q);
    if (!(message instanceof Uint8Array)) throw new TypeError("message must be a Uint8Array");
    const randomizer = c ?? lmots.randomizer(leaf, message);
    const o = LMS_SIGNATURE_OFFSETS;
    const sig = new Uint8Array(LMS_SIGNATURE_LEN);
    putBe32(sig, o.q, q);
    putBe32(sig, o.otsType, LMS_OTS_TYPE);
    sig.set(lmots.sign(leaf, message, randomizer), o.c);
    putBe32(sig, o.lmsType, LMS_TYPE);
    sig.set(this.authPath(q), o.path);
    if (lmsVerify(this.publicKey, message, sig) !== q) {
      sig.fill(0);
      throw new Error("LMS signature failed self-verification (the tree does not belong to this key); nothing was released");
    }
    return sig;
  }

  /**
   * The public tree and its tag, for `lmsKeyPairFromTreeCache` (65,536 bytes):
   * `T[1] || .. || T[2047] || HMAC-SHA256(SEED, TREE_CACHE_TAG || I || nodes)`.
   * Not secret, but only this key can tag it.
   */
  exportTreeCache(): Uint8Array {
    if (this.#wiped) throw new Error("this LMS key pair was wiped");
    const nodes = this.#nodes.subarray(N);
    const out = new Uint8Array(TREE_CACHE_LEN);
    out.set(nodes, 0);
    out.set(treeCacheTag(this.#seed, this.#id, nodes), nodes.length);
    return out;
  }

  /** Overwrite the copy of `SEED` this key pair holds; signing then throws. Best effort (see the module docs). */
  wipe(): void {
    this.#seed.fill(0);
    this.#probeKey?.fill(0);
    this.#probeKey = null;
    this.#wiped = true;
  }
}

const CONSTRUCT = Symbol("LmsKeyPair");

/**
 * INTERNAL (not exported from the package root): sign `message` at leaf `q`
 * of `keyPair` with the deterministic randomizer
 * `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32str(q) || message)`,
 * so signing the same message at the same leaf again yields the identical
 * 2,508 bytes. It records nothing: each leaf may sign ONE message, ever, so
 * the only caller is `leafLedger.reserveAndSign`, which reserves the leaf
 * durably first and records the signature before returning it. Throws
 * (releasing nothing) if the result does not verify.
 */
export function signLeafDeterministic(keyPair: LmsKeyPair, q: number, message: Uint8Array): Uint8Array {
  if (!(keyPair instanceof LmsKeyPair)) throw new TypeError("keyPair must be an LmsKeyPair");
  return signWithKeyPair(keyPair, q, message, null);
}

/**
 * INTERNAL, RFC 8554 known answers only (not exported from the package
 * root): RFC 8554 section 5.4.1 with a caller-supplied randomizer `c`. Two
 * different `c` at one leaf are two one-time signatures, and anyone holding
 * both can forge at that leaf.
 */
export function signLeafWithRandomizer(keyPair: LmsKeyPair, q: number, message: Uint8Array, c: Uint8Array): Uint8Array {
  if (!(keyPair instanceof LmsKeyPair)) throw new TypeError("keyPair must be an LmsKeyPair");
  if (!(c instanceof Uint8Array)) throw new TypeError("c must be a Uint8Array");
  return signWithKeyPair(keyPair, q, message, c);
}

function treeCacheTag(seed: Uint8Array, id: Uint8Array, nodes: Uint8Array): Uint8Array {
  return lmots.hmacSha256(seed, [TREE_CACHE_TAG, id, nodes]);
}

/** Progress and scheduling of `lmsKeygen`. */
export interface LmsKeygenOptions {
  /** Called after every time slice and once at the end with leaves done out of 1,024. */
  onProgress?: (leavesDone: number, leavesTotal: number) => void;
  /** Aborts between slices (rejects with `signal.reason`); working state is wiped. */
  signal?: AbortSignal;
  /** Work per slice before yielding, in milliseconds (default 12; at least one leaf per slice). */
  sliceMs?: number;
  /**
   * How to yield to the event loop between slices. Default: `scheduler.yield()`
   * where available, else `setImmediate` (Node), else a `MessageChannel`
   * message, else `setTimeout(0)`.
   */
  yieldToEventLoop?: () => Promise<void>;
}

type Yielder = () => Promise<void>;

interface MessagePortLike {
  onmessage: ((ev: unknown) => void) | null;
  postMessage(v: unknown): void;
  close(): void;
}

function defaultYield(): Promise<void> {
  const g = globalThis as unknown as {
    scheduler?: { yield?: () => Promise<void> };
    setImmediate?: (cb: () => void) => unknown;
    MessageChannel?: new () => { port1: MessagePortLike; port2: MessagePortLike };
  };
  if (typeof g.scheduler?.yield === "function") return g.scheduler.yield();
  if (typeof g.setImmediate === "function") {
    const setImmediate = g.setImmediate;
    return new Promise((resolve) => setImmediate(resolve));
  }
  if (typeof g.MessageChannel === "function") {
    const ch = new g.MessageChannel();
    return new Promise((resolve) => {
      ch.port1.onmessage = () => {
        ch.port1.close();
        ch.port2.close();
        resolve();
      };
      ch.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clock(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf !== undefined ? () => perf.now() : () => Date.now();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("LMS key generation aborted");
}

/** The shared work of `lmsKeygen` / `lmsKeygenSync`: leaves `from..to` into `leafKeys`. */
function computeLeaves(sk: LmsPrivateKey, idWords: Int32Array, kbuf: Uint8Array, leafKeys: Uint8Array, from: number, to: number): void {
  for (let q = from; q < to; q++) leafKeys.set(leafKeyHash(idWords, sk.id, sk.seed, q, kbuf), q * N);
}

function idWordsOf(id: Uint8Array): Int32Array {
  const w = new Int32Array(4);
  for (let k = 0; k < 4; k++) w[k] = (id[4 * k]! << 24) | (id[4 * k + 1]! << 16) | (id[4 * k + 2]! << 8) | id[4 * k + 3]!;
  return w;
}

/**
 * Build the whole tree (RFC 8554 sections 5.2 and 5.3) in one synchronous
 * call (~0.6-1 s in Node): for a Web Worker, or where blocking is fine.
 */
export function lmsKeygenSync(sk: LmsPrivateKey): LmsKeyPair {
  checkPrivateKey(sk);
  const key = { seed: Uint8Array.from(sk.seed), id: Uint8Array.from(sk.id) };
  try {
    const leafKeys = new Uint8Array(LMS_LEAVES * N);
    computeLeaves(key, idWordsOf(key.id), new Uint8Array(ID_LEN + 6 + P * N), leafKeys, 0, LMS_LEAVES);
    return new LmsKeyPair(key, buildTree(key.id, leafKeys), CONSTRUCT);
  } finally {
    key.seed.fill(0);
  }
}

/**
 * Build the whole tree without blocking the event loop: the 1,024 leaves are
 * computed in time slices of about `sliceMs`, with `onProgress` after each
 * and a yield between them; then the 2,047 nodes (a few milliseconds).
 * Measured in Node 22.20 on a Ryzen 7 5800X: about 0.6 s, sync or async
 * (`test/lms.test.ts` logs it on every run); a browser runs the same
 * JIT-compiled integer code.
 */
export async function lmsKeygen(sk: LmsPrivateKey, opts: LmsKeygenOptions = {}): Promise<LmsKeyPair> {
  checkPrivateKey(sk);
  const sliceMs = opts.sliceMs ?? 12;
  if (typeof sliceMs !== "number" || !(sliceMs > 0)) throw new RangeError("sliceMs must be a positive number");
  const yieldNow: Yielder = opts.yieldToEventLoop ?? defaultYield;
  const now = clock();
  const key = { seed: Uint8Array.from(sk.seed), id: Uint8Array.from(sk.id) };
  try {
    const idWords = idWordsOf(key.id);
    const kbuf = new Uint8Array(ID_LEN + 6 + P * N);
    const leafKeys = new Uint8Array(LMS_LEAVES * N);
    let q = 0;
    while (q < LMS_LEAVES) {
      if (opts.signal?.aborted === true) throw abortReason(opts.signal);
      const start = now();
      do {
        computeLeaves(key, idWords, kbuf, leafKeys, q, q + 1);
        q++;
      } while (q < LMS_LEAVES && now() - start < sliceMs);
      opts.onProgress?.(q, LMS_LEAVES);
      if (q < LMS_LEAVES) await yieldNow();
    }
    if (opts.signal?.aborted === true) throw abortReason(opts.signal);
    return new LmsKeyPair(key, buildTree(key.id, leafKeys), CONSTRUCT);
  } finally {
    key.seed.fill(0);
  }
}

/**
 * A key pair from a tree cache written by `exportTreeCache`, without a key
 * generation. Refuses (throws) a cache of the wrong length, one whose HMAC
 * under this key's `SEED` does not match (written by someone else, or for
 * another key), one whose interior nodes do not hash to their children, and,
 * when `expectedPublicKey` is given (from the launch's `pq_identity` or the
 * identity account), a root that differs from it.
 */
export function lmsKeyPairFromTreeCache(sk: LmsPrivateKey, cache: Uint8Array, opts: { expectedPublicKey?: Uint8Array } = {}): LmsKeyPair {
  checkPrivateKey(sk);
  checkLen("tree cache", cache, TREE_CACHE_LEN);
  const nodes = cache.subarray(0, LMS_TREE_NODES * N);
  if (!bytesEqual(treeCacheTag(sk.seed, sk.id, nodes), cache.subarray(LMS_TREE_NODES * N))) {
    throw new Error("LMS tree cache refused: its tag does not match this key (another key's tree, or written without the secret)");
  }
  const tree = new Uint8Array(2 * LMS_LEAVES * N);
  tree.set(nodes, N);
  const inner = interiorBuffer(sk.id);
  for (let r = LMS_LEAVES - 1; r >= 1; r--) {
    if (!bytesEqual(interiorNode(inner, tree, r), tree.subarray(r * N, (r + 1) * N))) {
      throw new Error(`LMS tree cache refused: node ${r} does not hash to its children`);
    }
  }
  const kp = new LmsKeyPair(sk, tree, CONSTRUCT);
  if (opts.expectedPublicKey !== undefined && !bytesEqual(kp.publicKey, opts.expectedPublicKey)) {
    kp.wipe();
    throw new Error("LMS tree cache refused: its public key is not the expected one");
  }
  return kp;
}

/** Where `lmsKeyPair` keeps tree caches (e.g. IndexedDB); values are `exportTreeCache` bytes. */
export interface LmsTreeCacheStore {
  get(key: string): Promise<Uint8Array | null | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
}

/** The store key of a private key's tree cache: `"noised/pq/lms-tree/v1/" + hex(I)` (I is public). */
export function treeCacheKey(sk: Pick<LmsPrivateKey, "id">): string {
  checkLen("I", sk.id, ID_LEN);
  return `noised/pq/lms-tree/v1/${toHex(sk.id)}`;
}

/** Where releases before the rename to Noised kept the same cache (read when the new key holds none; the cache is checked by its tag either way). */
export function legacyTreeCacheKey(sk: Pick<LmsPrivateKey, "id">): string {
  checkLen("I", sk.id, ID_LEN);
  return `phalanx/pq/lms-tree/v1/${toHex(sk.id)}`;
}

/** An in-memory `LmsTreeCacheStore` (tests, or one session). */
export function memoryTreeCacheStore(): LmsTreeCacheStore {
  const m = new Map<string, Uint8Array>();
  return {
    get: (key) => Promise.resolve(m.get(key)?.slice() ?? null),
    put: (key, value) => {
      m.set(key, Uint8Array.from(value));
      return Promise.resolve();
    },
  };
}

/** Options of `lmsKeyPair`. */
export interface LmsKeyPairOptions extends LmsKeygenOptions {
  /** Tree cache: read before generating, written after. */
  cache?: LmsTreeCacheStore;
  /** Refuse a key pair (cached or generated) whose public key differs. */
  expectedPublicKey?: Uint8Array;
  /** Called when a cached tree is refused (it is then regenerated and overwritten). */
  onCacheRejected?: (reason: unknown) => void;
}

/**
 * The key pair of `sk`: from `opts.cache` when it holds a valid tree for this
 * key (milliseconds), else by `lmsKeygen` (then cached).
 */
export async function lmsKeyPair(sk: LmsPrivateKey, opts: LmsKeyPairOptions = {}): Promise<LmsKeyPair> {
  checkPrivateKey(sk);
  const { cache, expectedPublicKey, onCacheRejected, ...keygen } = opts;
  if (cache !== undefined) {
    const blob = (await cache.get(treeCacheKey(sk))) ?? (await cache.get(legacyTreeCacheKey(sk)));
    if (blob !== null && blob !== undefined) {
      try {
        const kp = lmsKeyPairFromTreeCache(sk, blob, expectedPublicKey === undefined ? {} : { expectedPublicKey });
        opts.onProgress?.(LMS_LEAVES, LMS_LEAVES);
        return kp;
      } catch (e) {
        onCacheRejected?.(e);
      }
    }
  }
  const kp = await lmsKeygen(sk, keygen);
  if (expectedPublicKey !== undefined && !bytesEqual(kp.publicKey, expectedPublicKey)) {
    kp.wipe();
    throw new Error("this LMS key's public key is not the expected one (wrong phrase, passkey, cluster or identity index?)");
  }
  if (cache !== undefined) await cache.put(treeCacheKey(sk), kp.exportTreeCache());
  return kp;
}

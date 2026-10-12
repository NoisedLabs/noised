/**
 * A real LM-OTS_SHA256_N32_W4 one-time signature (RFC 8554 section 4, Appendix A key generation) computed in the
 * browser for the whitepaper's interactive figures. The key is a DEMO key derived from a public string: anyone can
 * recompute it, so it protects nothing. It exists to show the actual digits, checksum and hash counts of a message
 * you type. The randomizer follows Noised's deterministic rule, C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I ||
 * u32str(q) || message) (SPEC §3.10), so the same message always gives the same signature.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { allDigits, CHAIN_END, P } from "./lmots";

const enc = new TextEncoder();

function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

function u16(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 255, v & 255]);
}

export function hex(b: Uint8Array, n = b.length): string {
  return Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, "0")).join("");
}

const D_MESG = new Uint8Array([0x81, 0x81]);
const D_PBLC = new Uint8Array([0x80, 0x80]);

export interface DemoSignature {
  message: string;
  I: Uint8Array;
  q: number;
  C: Uint8Array;
  Q: Uint8Array;
  digits: number[];
  checksum: number;
  /** Hashes the signer computed: 67 secrets + sum of digits chain steps. */
  signerHashes: number;
  /** Chain steps the verifier computed: sum of (15 - digit). */
  verifierSteps: number;
  /** Public key hash K (the verifier recomputes and compares it). */
  K: Uint8Array;
  ok: boolean;
}

// kept from the original name: the demo key's derivation (its signatures are shown in the whitepaper)
const SEED = sha256(enc.encode("phalanx/whitepaper/demo-key: public, protects nothing"));
const I = sha256(enc.encode("phalanx/whitepaper/demo-id")).slice(0, 16);

function chain(i: number, start: Uint8Array, from: number, to: number): Uint8Array {
  let tmp = start;
  for (let j = from; j < to; j++) tmp = sha256(cat(I, u32(0), u16(i), new Uint8Array([j]), tmp));
  return tmp;
}

let cachedK: Uint8Array | null = null;

/** The demo key's public K (computed once: 67 x 15 chain steps). */
function publicK(): Uint8Array {
  if (cachedK) return cachedK;
  const z: Uint8Array[] = [];
  for (let i = 0; i < P; i++) {
    const x = sha256(cat(I, u32(0), u16(i), new Uint8Array([0xff]), SEED));
    z.push(chain(i, x, 0, CHAIN_END));
  }
  cachedK = sha256(cat(I, u32(0), D_PBLC, ...z));
  return cachedK;
}

/** Sign `message` with the demo key at q = 0 and verify it; returns everything the figures draw. */
export function demoSign(message: string): DemoSignature {
  const msg = enc.encode(message);
  const q = 0;
  const C = hmac(sha256, SEED, cat(enc.encode("phalanx/pq/lmots/C"), I, u32(q), msg));
  const Q = sha256(cat(I, u32(q), D_MESG, C, msg));
  const digits = allDigits(Q);
  let checksum = 0;
  for (let i = 0; i < 64; i++) checksum += CHAIN_END - (digits[i] ?? 0);
  // Signer: y_i = chain(x_i, 0 .. a_i).
  const y: Uint8Array[] = [];
  for (let i = 0; i < P; i++) {
    const x = sha256(cat(I, u32(q), u16(i), new Uint8Array([0xff]), SEED));
    y.push(chain(i, x, 0, digits[i] ?? 0));
  }
  // Verifier: z_i = chain(y_i, a_i .. 15), K' = H(I || q || D_PBLC || z_0 .. z_66).
  const z = y.map((yi, i) => chain(i, yi, digits[i] ?? 0, CHAIN_END));
  const Kc = sha256(cat(I, u32(q), D_PBLC, ...z));
  const K = publicK();
  const ok = Kc.every((b, i) => b === K[i]);
  const signerHashes = P + digits.reduce((a, d) => a + d, 0);
  const verifierSteps = digits.reduce((a, d) => a + (CHAIN_END - d), 0);
  return { message, I, q, C, Q, digits, checksum, signerHashes, verifierSteps, K, ok };
}

/** Digits of SHA-256(text), with the LM-OTS checksum appended (for the cover art). */
export function digitsOfText(text: string): number[] {
  return allDigits(sha256(enc.encode(text)));
}

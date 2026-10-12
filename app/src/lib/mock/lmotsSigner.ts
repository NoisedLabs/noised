/**
 * MOCK ONLY: the deterministic LM-OTS signer (RFC 8554 Algorithm 3 with
 * Appendix A secrets, LMOTS_SHA256_N32_W4) the simulated chain's
 * `prepareWithdrawal` signs with, byte-identical to the SDK's internal
 * `signDeterministic` (test/vault-vectors.test.ts checks it against the
 * Rust vectors). The SDK exports no raw signer: its signing entry points
 * need an RPC endpoint, which the simulated chain does not have.
 *
 * It records nothing. Its only caller is `signRecorded` in ./vault.ts, which
 * reserves the key in the vault-key ledger before signing and records the
 * signature before returning it, exactly like the SDK's. It is compiled only
 * into demo builds (and tests): src/lib/mock is never part of a live bundle.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { lmots, type LmotsPublicKey } from "@noisedlabs/sdk";

const D_MESG = Uint8Array.of(0x81, 0x81);

function u32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
}

function u16be(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, false);
  return b;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** `Q || Cksm(Q)` of RFC 8554 section 4.4. */
function digest(id: Uint8Array, q: number, c: Uint8Array, msg: Uint8Array): Uint8Array {
  const qHash = sha256(concat([id, u32be(q), D_MESG, c, msg]));
  let sum = 0;
  for (const byte of qHash) sum += lmots.CHAIN_END - (byte >> 4) + (lmots.CHAIN_END - (byte & 0x0f));
  return concat([qHash, u16be((sum << lmots.LS) & 0xffff)]);
}

/** Chain `value` from step `start` to step `end` (exclusive) for chain `i`. */
function walk(id: Uint8Array, q: number, i: number, start: number, end: number, value: Uint8Array): Uint8Array {
  const buf = new Uint8Array(lmots.ID_LEN + 4 + 2 + 1 + lmots.N);
  buf.set(id, 0);
  buf.set(u32be(q), 16);
  buf.set(u16be(i), 20);
  buf.set(value, 23);
  for (let j = start; j < end; j++) {
    buf[22] = j;
    buf.set(sha256(buf), 23);
  }
  return buf.slice(23, 55);
}

/**
 * The deterministic signature `C || y[0..67]` of `msg` by the one-time key
 * (`id`, `q`, `seed`), with `C = lmots.randomizer(sk, msg)`; self-verified
 * against `pk` before it is returned.
 */
export function mockSignDeterministic(seed: Uint8Array, pk: LmotsPublicKey, msg: Uint8Array): Uint8Array {
  const sk = { id: pk.id, q: pk.q, seed };
  const c = lmots.randomizer(sk, msg);
  const v = digest(pk.id, pk.q, c, msg);
  const out = new Uint8Array(lmots.SIG_LEN);
  out.set(c, 0);
  for (let i = 0; i < lmots.P; i++) {
    const secret = sha256(concat([pk.id, u32be(pk.q), u16be(i), Uint8Array.of(0xff), seed]));
    const a = i % 2 === 0 ? (v[i >> 1] ?? 0) >> 4 : (v[i >> 1] ?? 0) & 0x0f;
    out.set(walk(pk.id, pk.q, i, 0, a, secret), lmots.N + i * lmots.N);
  }
  if (!lmots.verify(pk, msg, out)) throw new Error("signature self-check failed");
  return out;
}

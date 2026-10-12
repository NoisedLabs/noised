/** Byte helpers shared by every module. No dependencies beyond the platform. */

export const U8_MAX = 0xff;
export const U16_MAX = 0xffff;
export const U32_MAX = 0xffff_ffff;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

/** True if `v` is an integer in `0..=max` (a JS number). */
export function isUint(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

export function isU64(v: unknown): v is bigint {
  return typeof v === "bigint" && v >= 0n && v <= U64_MAX;
}

export function isU128(v: unknown): v is bigint {
  return typeof v === "bigint" && v >= 0n && v <= U128_MAX;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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

/** Constant-time for equal lengths (lengths are public). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Lexicographic byte order (the order of Rust's `Pubkey: Ord`). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Constant-time in the contents (it also checks secrets, e.g. a wiped master seed). */
export function isAllZero(b: Uint8Array): boolean {
  let acc = 0;
  for (const x of b) acc |= x;
  return acc === 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8 decode (throws on invalid sequences, like Rust's `String`). */
export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

/** Byte length of `s` encoded as UTF-8 (what Rust's `str::len` returns). */
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function u16le(v: number): Uint8Array {
  if (!isUint(v, U16_MAX)) throw new RangeError(`u16 out of range: ${v}`);
  return Uint8Array.of(v & 0xff, v >>> 8);
}

export function u32le(v: number): Uint8Array {
  if (!isUint(v, U32_MAX)) throw new RangeError(`u32 out of range: ${v}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

export function u64le(v: bigint): Uint8Array {
  if (!isU64(v)) throw new RangeError(`u64 out of range: ${String(v)}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

/** Fresh random bytes from the platform CSPRNG (Web Crypto). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues is limited to 65,536 bytes per call.
  for (let off = 0; off < n; off += 65_536) {
    globalThis.crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65_536)));
  }
  return out;
}

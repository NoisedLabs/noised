/** Little-endian byte helpers, base58 addresses and key normalization (no Node APIs). */
import { ProgError } from "./errors.js";

/** A base58 Solana address (32 bytes). */
export type Address = string;

/** Anything that names a 32-byte key: base58 text, raw bytes, or a web3.js PublicKey. */
export type KeyInput = string | Uint8Array | { toBytes(): Uint8Array } | { toBase58(): string };

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

/** Decodes base58; null if a character is outside the alphabet. */
export function decodeBase58(s: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/** True if `s` is base58 text of exactly 32 bytes. */
export function isAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  const b = decodeBase58(s);
  return b !== null && b.length === 32;
}

/** The all-zero key (Pubkey::default()). */
export const DEFAULT_ADDRESS: Address = encodeBase58(new Uint8Array(32));

/** Normalizes a key to its base58 address; throws ProgError("BadAddress"). */
export function toAddress(k: KeyInput): Address {
  if (typeof k === "string") {
    if (!isAddress(k)) throw new ProgError("BadAddress", `"${k}" is not a Solana address`);
    return encodeBase58(decodeBase58(k)!); // canonical form
  }
  if (k instanceof Uint8Array) {
    if (k.length !== 32) throw new ProgError("BadAddress", `a key must be 32 bytes, got ${k.length}`);
    return encodeBase58(k);
  }
  if ("toBytes" in k && typeof k.toBytes === "function") return toAddress(k.toBytes());
  if ("toBase58" in k && typeof k.toBase58 === "function") return toAddress(k.toBase58());
  throw new ProgError("BadAddress", "unsupported key value");
}

export function addressBytes(a: Address): Uint8Array {
  const b = decodeBase58(a);
  if (b === null || b.length !== 32) throw new ProgError("BadAddress", `"${a}" is not a Solana address`);
  return b;
}

/** "7xKX…AsU" for display. */
export function shortAddress(a: Address): string {
  return a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Growable little-endian writer. Strict: a value that does not fit its field
 * (negative, fractional, too wide) throws ProgError("BadModel") instead of
 * being truncated, so the bytes always say exactly what the model says (a
 * budget of -1 must never become u64::MAX, a share of 70536 bps never 5000).
 */
export class ByteWriter {
  private buf: number[] = [];
  private uint(v: number, bits: 8 | 16 | 32): number {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 2 ** bits - 1) {
      throw new ProgError("BadModel", `${String(v)} does not fit an unsigned ${bits}-bit field`);
    }
    return v;
  }
  u8(v: number): this {
    this.buf.push(this.uint(v, 8));
    return this;
  }
  u16(v: number): this {
    const x = this.uint(v, 16);
    this.buf.push(x & 0xff, x >>> 8);
    return this;
  }
  u32(v: number): this {
    const x = this.uint(v, 32);
    this.buf.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, x >>> 24);
    return this;
  }
  u64(v: bigint): this {
    if (typeof v !== "bigint" || v < 0n || v > 0xffff_ffff_ffff_ffffn) {
      throw new ProgError("BadModel", `${String(v)} does not fit an unsigned 64-bit field`);
    }
    for (let i = 0n; i < 8n; i++) this.buf.push(Number((v >> (8n * i)) & 0xffn));
    return this;
  }
  /** Raw bytes; `len` (when given) is the exact length the field needs. */
  bytes(b: Uint8Array, len?: number): this {
    if (len !== undefined && b.length !== len) throw new ProgError("BadModel", `a ${len}-byte field got ${b.length} bytes`);
    for (const x of b) this.buf.push(x);
    return this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.buf.push(0);
    return this;
  }
  get length(): number {
    return this.buf.length;
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** Little-endian reader over a fixed buffer (callers check lengths first). */
export class ByteReader {
  constructor(
    private readonly b: Uint8Array,
    public pos = 0,
  ) {}
  u8(): number {
    return this.b[this.pos++]!;
  }
  u16(): number {
    const v = this.b[this.pos]! | (this.b[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v =
      (this.b[this.pos]! | (this.b[this.pos + 1]! << 8) | (this.b[this.pos + 2]! << 16)) +
      this.b[this.pos + 3]! * 0x1_00_00_00;
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.pos + i]!);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/**
 * Strict borsh reader and writer with `bigint` for 64/128-bit integers.
 *
 * Strictness matches Rust's `borsh` deserialization: booleans must be 0 or 1,
 * option tags 0 or 1, strings valid UTF-8, and reads never run past the end.
 */
import { PublicKey } from "@solana/web3.js";

import { concatBytes, fromUtf8, isUint, U16_MAX, U32_MAX, U8_MAX, utf8 } from "./bytes.js";

export class BorshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BorshError";
  }
}

export class BorshReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  private need(n: number): void {
    if (n < 0 || this.offset + n > this.data.length) {
      throw new BorshError(`unexpected end of data: need ${n} bytes at offset ${this.offset}, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.data[this.offset++]!;
  }

  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }

  i128(): bigint {
    const v = this.u128();
    return v >= 1n << 127n ? v - (1n << 128n) : v;
  }

  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new BorshError(`invalid bool byte ${b} at offset ${this.offset - 1}`);
    return b === 1;
  }

  fixed(n: number): Uint8Array {
    this.need(n);
    const out = this.data.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  pubkey(): PublicKey {
    return new PublicKey(this.fixed(32));
  }

  bytes(): Uint8Array {
    return this.fixed(this.u32());
  }

  string(): string {
    const raw = this.bytes();
    try {
      return fromUtf8(raw);
    } catch {
      throw new BorshError("invalid UTF-8 string");
    }
  }

  optionTag(): boolean {
    const tag = this.u8();
    if (tag > 1) throw new BorshError(`invalid option tag ${tag} at offset ${this.offset - 1}`);
    return tag === 1;
  }
}

export class BorshWriter {
  private readonly chunks: Uint8Array[] = [];

  private push(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }

  private uintLe(v: bigint, bytes: number): this {
    const out = new Uint8Array(bytes);
    let x = v;
    for (let i = 0; i < bytes; i++) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return this.push(out);
  }

  private intLe(v: bigint, bits: number): this {
    const min = -(1n << BigInt(bits - 1));
    const max = (1n << BigInt(bits - 1)) - 1n;
    if (v < min || v > max) throw new RangeError(`i${bits} out of range: ${String(v)}`);
    return this.uintLe(v < 0n ? v + (1n << BigInt(bits)) : v, bits / 8);
  }

  u8(v: number): this {
    if (!isUint(v, U8_MAX)) throw new RangeError(`u8 out of range: ${v}`);
    return this.push(Uint8Array.of(v));
  }

  i8(v: number): this {
    if (!Number.isInteger(v)) throw new RangeError(`i8 out of range: ${v}`);
    return this.intLe(BigInt(v), 8);
  }

  u16(v: number): this {
    if (!isUint(v, U16_MAX)) throw new RangeError(`u16 out of range: ${v}`);
    return this.uintLe(BigInt(v), 2);
  }

  i16(v: number): this {
    if (!Number.isInteger(v)) throw new RangeError(`i16 out of range: ${v}`);
    return this.intLe(BigInt(v), 16);
  }

  u32(v: number): this {
    if (!isUint(v, U32_MAX)) throw new RangeError(`u32 out of range: ${v}`);
    return this.uintLe(BigInt(v), 4);
  }

  i32(v: number): this {
    if (!Number.isInteger(v)) throw new RangeError(`i32 out of range: ${v}`);
    return this.intLe(BigInt(v), 32);
  }

  u64(v: bigint): this {
    if (typeof v !== "bigint" || v < 0n || v >= 1n << 64n) throw new RangeError(`u64 out of range: ${String(v)}`);
    return this.uintLe(v, 8);
  }

  i64(v: bigint): this {
    if (typeof v !== "bigint") throw new RangeError(`i64 must be a bigint`);
    return this.intLe(v, 64);
  }

  u128(v: bigint): this {
    if (typeof v !== "bigint" || v < 0n || v >= 1n << 128n) throw new RangeError(`u128 out of range: ${String(v)}`);
    return this.uintLe(v, 16);
  }

  i128(v: bigint): this {
    if (typeof v !== "bigint") throw new RangeError(`i128 must be a bigint`);
    return this.intLe(v, 128);
  }

  bool(v: boolean): this {
    if (typeof v !== "boolean") throw new TypeError("bool expected");
    return this.push(Uint8Array.of(v ? 1 : 0));
  }

  fixed(bytes: Uint8Array, len: number): this {
    if (!(bytes instanceof Uint8Array) || bytes.length !== len) {
      throw new RangeError(`expected ${len} bytes, got ${bytes instanceof Uint8Array ? bytes.length : typeof bytes}`);
    }
    return this.push(Uint8Array.from(bytes));
  }

  pubkey(k: PublicKey): this {
    return this.push(k.toBytes());
  }

  bytes(bytes: Uint8Array): this {
    return this.u32(bytes.length).push(Uint8Array.from(bytes));
  }

  string(s: string): this {
    return this.bytes(utf8(s));
  }

  raw(bytes: Uint8Array): this {
    return this.push(Uint8Array.from(bytes));
  }

  toBytes(): Uint8Array {
    return concatBytes(this.chunks);
  }
}

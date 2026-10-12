/** v1 transaction format (SIMD-0385) as written in docs/SPEC.md §3. */
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";

import { encodeBase58 } from "../src/codec/base58.js";
import { compareBytes, concatBytes, u32le, u64le } from "../src/codec/bytes.js";
import { compileV1Message, decodeV1Transaction, signV1Message, v1TransactionId, verifyV1Signatures } from "../src/tx/v1.js";

const kp = (n: number): Keypair => Keypair.fromSeed(new Uint8Array(32).fill(n));
const acct = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const BLOCKHASH = encodeBase58(new Uint8Array(32).fill(7));

function ix(program: PublicKey, keys: [PublicKey, boolean, boolean][], data: number[]): TransactionInstruction {
  return new TransactionInstruction({ programId: program, keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })), data: Buffer.from(data) });
}

describe("v1 message layout", () => {
  const payer = kp(1);
  const other = kp(2);
  const program = acct(200);
  const ixs = [
    ix(program, [
      [acct(50), false, true],
      [other.publicKey, true, false],
      [acct(40), false, false],
      [payer.publicKey, false, false],
    ], [1, 2, 3]),
    ix(acct(150), [[acct(40), false, true]], [9]),
  ];

  it("orders addresses like CompiledKeys: payer, writable signers, readonly signers, writable, readonly (each by bytes)", () => {
    const m = compileV1Message(payer.publicKey, ixs, BLOCKHASH, { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 4 << 20 });
    const keys = m.accountKeys;
    expect(keys[0]!.equals(payer.publicKey)).toBe(true);
    expect(m.header).toEqual({ numRequiredSignatures: 2, numReadonlySigned: 1, numReadonlyUnsigned: 2 });
    expect(keys[1]!.equals(other.publicKey)).toBe(true);
    const writable = keys.slice(2, 4);
    expect(writable.map((k) => k.toBase58()).sort()).toEqual([acct(50), acct(40)].map((k) => k.toBase58()).sort());
    expect(compareBytes(writable[0]!.toBytes(), writable[1]!.toBytes())).toBe(-1);
    const readonly = keys.slice(4);
    expect(readonly.length).toBe(2);
    expect(compareBytes(readonly[0]!.toBytes(), readonly[1]!.toBytes())).toBe(-1);
  });

  it("writes the exact SPEC layout", () => {
    const m = compileV1Message(payer.publicKey, ixs, BLOCKHASH, { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 4 << 20 });
    const idx = (k: PublicKey): number => m.accountKeys.findIndex((x) => x.equals(k));
    const expected = concatBytes([
      Uint8Array.of(0x81, 2, 1, 2),
      u32le(0b1100),
      new Uint8Array(32).fill(7),
      Uint8Array.of(2, m.accountKeys.length),
      ...m.accountKeys.map((k) => k.toBytes()),
      u32le(400_000),
      u32le(4 << 20),
      Uint8Array.of(idx(program), 4, 3, 0),
      Uint8Array.of(idx(acct(150)), 1, 1, 0),
      Uint8Array.of(idx(acct(50)), idx(other.publicKey), idx(acct(40)), idx(payer.publicKey), 1, 2, 3),
      Uint8Array.of(idx(acct(40)), 9),
    ]);
    expect(Buffer.from(m.bytes).toString("hex")).toBe(Buffer.from(expected).toString("hex"));
  });

  it("config words: priority fee (bits 0+1), CU (2), loaded data (3), heap (4) in that order", () => {
    const m = compileV1Message(payer.publicKey, [ixs[1]!], BLOCKHASH, {
      computeUnitLimit: 1,
      loadedAccountsDataSizeLimit: 2,
      priorityFeeLamports: 3n,
      heapSize: 64 * 1024,
    });
    const d = decodeV1Transaction(concatBytes([m.bytes, new Uint8Array(64)]));
    expect(d.configMask).toBe(0b11111);
    expect([d.priorityFeeLamports, d.computeUnitLimit, d.loadedAccountsDataSizeLimit, d.heapSize]).toEqual([3n, 1, 2, 65_536]);
    const start = 4 + 4 + 32 + 2 + 32 * m.accountKeys.length;
    expect(Buffer.from(m.bytes.subarray(start, start + 20)).toString("hex")).toBe(
      Buffer.from(concatBytes([u64le(3n), u32le(1), u32le(2), u32le(65_536)])).toString("hex"),
    );
  });

  it("signs the message bytes: message || signatures, no length prefix", () => {
    const m = compileV1Message(payer.publicKey, ixs, BLOCKHASH, { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 4 << 20 });
    const wire = signV1Message(m, [other, payer]);
    expect(wire.length).toBe(m.bytes.length + 128);
    const d = decodeV1Transaction(wire);
    expect(d.signatures.length).toBe(2);
    expect(verifyV1Signatures(d)).toBe(true);
    expect(v1TransactionId(wire)).toBe(encodeBase58(wire.subarray(m.bytes.length, m.bytes.length + 64)));
    const tampered = Uint8Array.from(wire);
    tampered[45] = tampered[45]! ^ 1;
    expect(verifyV1Signatures(decodeV1Transaction(tampered))).toBe(false);
    expect(() => signV1Message(m, [payer])).toThrow(/missing signer/);
    expect(() => signV1Message(m, [payer, other, kp(9)])).toThrow(/not required/);
  });

  it("refuses what v1 forbids or would make unusable", () => {
    const cfg = { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 4 << 20 };
    expect(() => compileV1Message(payer.publicKey, ixs, BLOCKHASH, { ...cfg, computeUnitLimit: 0 })).toThrow(/computeUnitLimit/);
    expect(() => compileV1Message(payer.publicKey, ixs, BLOCKHASH, { ...cfg, loadedAccountsDataSizeLimit: 0 })).toThrow(/loaded/);
    expect(() => compileV1Message(payer.publicKey, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })], BLOCKHASH, cfg)).toThrow(/ComputeBudget/);
    expect(() => compileV1Message(payer.publicKey, [ix(payer.publicKey, [], [])], BLOCKHASH, cfg)).toThrow(/fee payer/);
    expect(() => compileV1Message(payer.publicKey, ixs, BLOCKHASH, { ...cfg, heapSize: 1000 })).toThrow(/heap/);
    const many = ix(acct(201), Array.from({ length: 64 }, (_, i) => [acct(i + 1), false, false] as [PublicKey, boolean, boolean]), []);
    expect(() => compileV1Message(payer.publicKey, [many], BLOCKHASH, cfg)).toThrow(/64 addresses/);
    const big = ix(acct(201), [], Array.from({ length: 4_000 }, () => 1));
    expect(() => compileV1Message(payer.publicKey, [big], BLOCKHASH, cfg)).toThrow(/4096/);
  });

  it("decoder rejects malformed wire bytes", () => {
    const m = compileV1Message(payer.publicKey, [ixs[1]!], BLOCKHASH, { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 4 << 20 });
    const wire = signV1Message(m, [payer]);
    expect(() => decodeV1Transaction(wire.subarray(0, wire.length - 1))).toThrow();
    expect(() => decodeV1Transaction(concatBytes([wire, Uint8Array.of(0)]))).toThrow(/trailing/);
    const legacyPrefix = Uint8Array.from(wire);
    legacyPrefix[0] = 0x80;
    expect(() => decodeV1Transaction(legacyPrefix)).toThrow(/not a v1/);
    const unknownBit = Uint8Array.from(wire);
    unknownBit[4] = unknownBit[4]! | 0b100000;
    expect(() => decodeV1Transaction(unknownBit)).toThrow(/mask/);
    const halfFee = Uint8Array.from(wire);
    halfFee[4] = halfFee[4]! | 0b01;
    expect(() => decodeV1Transaction(halfFee)).toThrow(/priority fee/);
  });
});

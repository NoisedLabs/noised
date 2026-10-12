/**
 * v1 transactions (SIMD-0385, 4,096-byte limit), hand-serialized exactly as
 * `solana-message` 4.6 (`versions/v1`) compiles and `solana-transaction` 4.3
 * (`versioned/mod.rs`) writes them, and as docs/SPEC.md §3 describes:
 *
 *   transaction = message || signatures            (fixed count, no length prefix)
 *   message     = 0x81 || header[3] || config_mask u32 LE || recent_blockhash[32]
 *                 || num_instructions u8 || num_addresses u8 || addresses[32 * n]
 *                 || config_values || instruction_headers || instruction_payloads
 *   instruction_header  = program_id_index u8 || num_accounts u8 || data_len u16 LE
 *   instruction_payload = account_indices[num_accounts] || data
 *
 * Config values follow the mask bits in order: priority fee u64 (bits 0 and
 * 1), compute-unit limit u32 (bit 2), loaded-accounts-data-size limit u32
 * (bit 3), heap size u32 (bit 4). Unset limits mean 0 in v1, so the compute
 * and loaded-data limits are mandatory here. Addresses are ordered like
 * `CompiledKeys::compile`: fee payer, then writable signers, readonly
 * signers, writable non-signers, readonly non-signers, each group in byte
 * order. Byte-for-byte parity with the Rust crates is tested against
 * vectors produced by `tests/integration/tests/sdk_vectors.rs`.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey, type AccountMeta, type Keypair, type TransactionInstruction } from "@solana/web3.js";

import { decodeBase58, encodeBase58 } from "../codec/base58.js";
import { bytesEqual, compareBytes, concatBytes, isUint, U16_MAX, U32_MAX, u32le, u64le } from "../codec/bytes.js";
import { KNOWN_ACCOUNTS } from "../constants.js";

export const V1_VERSION_PREFIX = 0x81;
export const V1_MAX_TRANSACTION_SIZE = 4096;
export const V1_MAX_ADDRESSES = 64;
export const V1_MAX_INSTRUCTIONS = 64;
export const V1_MAX_SIGNATURES = 12;
export const V1_SIGNATURE_SIZE = 64;
export const CONFIG_PRIORITY_FEE = 0b0_0011;
export const CONFIG_COMPUTE_UNIT_LIMIT = 0b0_0100;
export const CONFIG_LOADED_ACCOUNTS_DATA_SIZE = 0b0_1000;
export const CONFIG_HEAP_SIZE = 0b1_0000;
const KNOWN_MASK = CONFIG_PRIORITY_FEE | CONFIG_COMPUTE_UNIT_LIMIT | CONFIG_LOADED_ACCOUNTS_DATA_SIZE | CONFIG_HEAP_SIZE;

export interface V1Config {
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  priorityFeeLamports?: bigint;
  heapSize?: number;
}

export interface V1Header {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
}

export interface CompiledV1Message {
  bytes: Uint8Array;
  accountKeys: PublicKey[];
  header: V1Header;
  configMask: number;
}

interface KeyFlags {
  key: PublicKey;
  bytes: Uint8Array;
  signer: boolean;
  writable: boolean;
}

type Ix = Pick<TransactionInstruction, "programId" | "keys"> & { data: Uint8Array };

/** `CompiledKeys::compile` + `try_into_message_components`. */
function orderAccounts(payer: PublicKey, instructions: readonly Ix[]): KeyFlags[] {
  const map = new Map<string, KeyFlags>();
  const upsert = (key: PublicKey, signer: boolean, writable: boolean): void => {
    const id = key.toBase58();
    const prev = map.get(id);
    if (prev) {
      prev.signer ||= signer;
      prev.writable ||= writable;
    } else map.set(id, { key, bytes: key.toBytes(), signer, writable });
  };
  for (const ix of instructions) {
    upsert(ix.programId, false, false);
    for (const k of ix.keys) upsert(k.pubkey, k.isSigner, k.isWritable);
  }
  upsert(payer, true, true);
  const payerId = payer.toBase58();
  const payerFlags = map.get(payerId)!;
  payerFlags.signer = true;
  payerFlags.writable = true;
  const rest = [...map.values()].filter((a) => a.key.toBase58() !== payerId).sort((a, b) => compareBytes(a.bytes, b.bytes));
  const group = (signer: boolean, writable: boolean): KeyFlags[] => rest.filter((a) => a.signer === signer && a.writable === writable);
  return [payerFlags, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
}

export function compileV1Message(
  payer: PublicKey,
  instructions: readonly Ix[],
  recentBlockhash: string,
  config: V1Config,
): CompiledV1Message {
  if (!isUint(config.computeUnitLimit, U32_MAX) || config.computeUnitLimit === 0) {
    throw new RangeError("v1: computeUnitLimit must be a non-zero u32 (unset means 0)");
  }
  if (!isUint(config.loadedAccountsDataSizeLimit, U32_MAX) || config.loadedAccountsDataSizeLimit === 0) {
    throw new RangeError("v1: loadedAccountsDataSizeLimit must be a non-zero u32 (unset means 0)");
  }
  if (instructions.length === 0 || instructions.length > V1_MAX_INSTRUCTIONS) throw new RangeError(`v1: 1..=${V1_MAX_INSTRUCTIONS} instructions`);
  for (const ix of instructions) {
    if (ix.programId.equals(KNOWN_ACCOUNTS.computeBudget)) {
      throw new Error("v1: ComputeBudget instructions are ignored in v1 transactions; use the config words");
    }
  }
  const accounts = orderAccounts(payer, instructions);
  if (accounts.length > V1_MAX_ADDRESSES) throw new RangeError(`v1: at most ${V1_MAX_ADDRESSES} addresses (got ${accounts.length})`);
  const header: V1Header = {
    numRequiredSignatures: accounts.filter((a) => a.signer).length,
    numReadonlySigned: accounts.filter((a) => a.signer && !a.writable).length,
    numReadonlyUnsigned: accounts.filter((a) => !a.signer && !a.writable).length,
  };
  if (header.numRequiredSignatures > V1_MAX_SIGNATURES) throw new RangeError(`v1: at most ${V1_MAX_SIGNATURES} signatures`);
  const index = new Map(accounts.map((a, i) => [a.key.toBase58(), i] as const));

  let mask = CONFIG_COMPUTE_UNIT_LIMIT | CONFIG_LOADED_ACCOUNTS_DATA_SIZE;
  const values: Uint8Array[] = [];
  if (config.priorityFeeLamports !== undefined) {
    mask |= CONFIG_PRIORITY_FEE;
    values.push(u64le(config.priorityFeeLamports));
  }
  values.push(u32le(config.computeUnitLimit));
  values.push(u32le(config.loadedAccountsDataSizeLimit));
  if (config.heapSize !== undefined) {
    if (!isUint(config.heapSize, U32_MAX) || config.heapSize % 1024 !== 0 || config.heapSize < 32 * 1024 || config.heapSize > 256 * 1024) {
      throw new RangeError("v1: heap size must be a multiple of 1024 between 32 and 256 KiB");
    }
    mask |= CONFIG_HEAP_SIZE;
    values.push(u32le(config.heapSize));
  }

  const blockhash = decodeBase58(recentBlockhash);
  if (blockhash.length !== 32) throw new RangeError("v1: recent blockhash must be 32 bytes");
  const headers: Uint8Array[] = [];
  const payloads: Uint8Array[] = [];
  for (const ix of instructions) {
    if (ix.keys.length > 255) throw new RangeError("v1: at most 255 accounts per instruction");
    if (!isUint(ix.data.length, U16_MAX)) throw new RangeError("v1: instruction data longer than 65,535 bytes");
    const programIndex = index.get(ix.programId.toBase58());
    if (programIndex === undefined || programIndex === 0) throw new Error("v1: the program cannot be the fee payer");
    const dataLen = new Uint8Array(2);
    new DataView(dataLen.buffer).setUint16(0, ix.data.length, true);
    headers.push(concatBytes([Uint8Array.of(programIndex, ix.keys.length), dataLen]));
    const idx = ix.keys.map((k: AccountMeta) => index.get(k.pubkey.toBase58())!);
    payloads.push(concatBytes([Uint8Array.from(idx), ix.data]));
  }

  const bytes = concatBytes([
    Uint8Array.of(V1_VERSION_PREFIX, header.numRequiredSignatures, header.numReadonlySigned, header.numReadonlyUnsigned),
    u32le(mask),
    blockhash,
    Uint8Array.of(instructions.length, accounts.length),
    ...accounts.map((a) => a.bytes),
    ...values,
    ...headers,
    ...payloads,
  ]);
  if (bytes.length + V1_SIGNATURE_SIZE * header.numRequiredSignatures > V1_MAX_TRANSACTION_SIZE) {
    throw new RangeError(`v1: transaction would be ${bytes.length + V1_SIGNATURE_SIZE * header.numRequiredSignatures} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);
  }
  return { bytes, accountKeys: accounts.map((a) => a.key), header, configMask: mask };
}

/** Sign the message with every required signer (in account order) and return the wire bytes. */
export function signV1Message(message: CompiledV1Message, signers: readonly Keypair[]): Uint8Array {
  const required = message.accountKeys.slice(0, message.header.numRequiredSignatures);
  const signatures = required.map((key) => {
    const signer = signers.find((s) => s.publicKey.equals(key));
    if (!signer) throw new Error(`v1: missing signer ${key.toBase58()}`);
    const seed = signer.secretKey.slice(0, 32);
    if (!bytesEqual(ed25519.getPublicKey(seed), key.toBytes())) throw new Error("v1: keypair secret does not match its public key");
    return ed25519.sign(message.bytes, seed);
  });
  const extra = signers.filter((s) => !required.some((k) => k.equals(s.publicKey)));
  if (extra.length > 0) throw new Error(`v1: signer ${extra[0]!.publicKey.toBase58()} is not required by the message`);
  const tx = concatBytes([message.bytes, ...signatures]);
  if (tx.length > V1_MAX_TRANSACTION_SIZE) throw new RangeError(`v1: transaction is ${tx.length} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);
  return tx;
}

export interface DecodedV1 {
  message: Uint8Array;
  signatures: Uint8Array[];
  header: V1Header;
  configMask: number;
  recentBlockhash: string;
  accountKeys: PublicKey[];
  instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
  priorityFeeLamports: bigint | null;
  computeUnitLimit: number | null;
  loadedAccountsDataSizeLimit: number | null;
  heapSize: number | null;
}

/** Parse v1 wire bytes (to inspect, simulate and test). Throws on malformed input. */
export function decodeV1Transaction(tx: Uint8Array): DecodedV1 {
  if (tx.length > V1_MAX_TRANSACTION_SIZE) throw new Error("v1: transaction exceeds 4,096 bytes");
  const view = new DataView(tx.buffer, tx.byteOffset, tx.byteLength);
  let off = 0;
  const need = (n: number): void => {
    if (off + n > tx.length) throw new Error("v1: truncated transaction");
  };
  need(8);
  if (tx[0] !== V1_VERSION_PREFIX) throw new Error("v1: not a v1 transaction");
  const header: V1Header = { numRequiredSignatures: tx[1]!, numReadonlySigned: tx[2]!, numReadonlyUnsigned: tx[3]! };
  const configMask = view.getUint32(4, true);
  if ((configMask & ~KNOWN_MASK) !== 0) throw new Error("v1: unknown config mask bits");
  if ((configMask & CONFIG_PRIORITY_FEE) !== 0 && (configMask & CONFIG_PRIORITY_FEE) !== CONFIG_PRIORITY_FEE) {
    throw new Error("v1: priority fee needs both mask bits 0 and 1");
  }
  off = 8;
  need(32);
  const recentBlockhash = encodeBase58(tx.slice(off, off + 32));
  off += 32;
  need(2);
  const numIx = tx[off]!;
  const numAddr = tx[off + 1]!;
  off += 2;
  if (numIx > V1_MAX_INSTRUCTIONS || numAddr > V1_MAX_ADDRESSES) throw new Error("v1: too many instructions or addresses");
  if (header.numRequiredSignatures === 0 || header.numRequiredSignatures > V1_MAX_SIGNATURES) throw new Error("v1: invalid signature count");
  if (header.numReadonlySigned >= header.numRequiredSignatures) throw new Error("v1: no writable fee payer");
  if (numAddr < header.numRequiredSignatures + header.numReadonlyUnsigned) throw new Error("v1: not enough addresses for the header");
  need(32 * numAddr);
  const accountKeys: PublicKey[] = [];
  for (let i = 0; i < numAddr; i++) accountKeys.push(new PublicKey(tx.slice(off + i * 32, off + (i + 1) * 32)));
  if (new Set(accountKeys.map((k) => k.toBase58())).size !== numAddr) throw new Error("v1: duplicate addresses");
  off += 32 * numAddr;
  let priorityFeeLamports: bigint | null = null;
  let computeUnitLimit: number | null = null;
  let loadedAccountsDataSizeLimit: number | null = null;
  let heapSize: number | null = null;
  if ((configMask & CONFIG_PRIORITY_FEE) !== 0) {
    need(8);
    priorityFeeLamports = view.getBigUint64(off, true);
    off += 8;
  }
  if ((configMask & CONFIG_COMPUTE_UNIT_LIMIT) !== 0) {
    need(4);
    computeUnitLimit = view.getUint32(off, true);
    off += 4;
  }
  if ((configMask & CONFIG_LOADED_ACCOUNTS_DATA_SIZE) !== 0) {
    need(4);
    loadedAccountsDataSizeLimit = view.getUint32(off, true);
    off += 4;
  }
  if ((configMask & CONFIG_HEAP_SIZE) !== 0) {
    need(4);
    heapSize = view.getUint32(off, true);
    off += 4;
  }
  need(4 * numIx);
  const ixHeaders: { programIdIndex: number; numAccounts: number; dataLen: number }[] = [];
  for (let i = 0; i < numIx; i++) {
    ixHeaders.push({ programIdIndex: tx[off]!, numAccounts: tx[off + 1]!, dataLen: view.getUint16(off + 2, true) });
    off += 4;
  }
  const instructions: DecodedV1["instructions"] = [];
  for (const h of ixHeaders) {
    need(h.numAccounts + h.dataLen);
    const accounts = Array.from(tx.slice(off, off + h.numAccounts));
    off += h.numAccounts;
    const data = tx.slice(off, off + h.dataLen);
    off += h.dataLen;
    if (h.programIdIndex === 0 || h.programIdIndex >= numAddr || accounts.some((a) => a >= numAddr)) {
      throw new Error("v1: account index out of range");
    }
    instructions.push({ programIdIndex: h.programIdIndex, accounts, data });
  }
  const message = tx.slice(0, off);
  const sigBytes = V1_SIGNATURE_SIZE * header.numRequiredSignatures;
  if (tx.length !== off + sigBytes) throw new Error("v1: trailing or missing signature bytes");
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < header.numRequiredSignatures; i++) signatures.push(tx.slice(off + i * 64, off + (i + 1) * 64));
  return {
    message,
    signatures,
    header,
    configMask,
    recentBlockhash,
    accountKeys,
    instructions,
    priorityFeeLamports,
    computeUnitLimit,
    loadedAccountsDataSizeLimit,
    heapSize,
  };
}

/** True if every required signature verifies over the message bytes. */
export function verifyV1Signatures(decoded: DecodedV1): boolean {
  return decoded.signatures.every((sig, i) => {
    const key = decoded.accountKeys[i];
    return key !== undefined && ed25519.verify(sig, decoded.message, key.toBytes());
  });
}

/** The transaction id: base58 of the fee payer's signature. */
export function v1TransactionId(tx: Uint8Array): string {
  const d = decodeV1Transaction(tx);
  return encodeBase58(d.signatures[0]!);
}

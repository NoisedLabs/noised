/**
 * Test helpers: an in-memory `Connection` and builders for raw SPL Token /
 * Token-2022 account bytes laid out exactly like the token programs write
 * them (base state, zero padding to 165 bytes, account type, TLV entries).
 */
import { readFileSync } from "node:fs";

import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, type AccountInfo, type Connection, type GetProgramAccountsFilter } from "@solana/web3.js";
import { Buffer } from "buffer";

import { decodeBase58 } from "../src/codec/base58.js";
import { concatBytes, fromHex, u32le, u64le } from "../src/codec/bytes.js";
import { KNOWN_ACCOUNTS } from "../src/constants.js";

export const hex = fromHex;

/** The Clock sysvar's address. */
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";

export function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as T;
}

/** A deterministic, distinct public key per label. */
export function key(label: string | number): PublicKey {
  const seed = typeof label === "number" ? Uint8Array.from({ length: 32 }, () => label) : new TextEncoder().encode(label.padEnd(32, "#").slice(0, 32));
  return new PublicKey(seed);
}

/** A wallet address (on the Ed25519 curve) named by `label`: a key a person could hold. */
export function wallet(label: string): PublicKey {
  return Keypair.fromSeed(sha256(new TextEncoder().encode(`wallet/${label}`))).publicKey;
}

export interface MockAccount {
  owner: PublicKey;
  data: Uint8Array;
  lamports?: number;
  executable?: boolean;
}

/** One entry of an address's transaction history (newest first), as `getSignaturesForAddress` lists it. */
export interface MockSignature {
  signature: string;
  slot: number;
  err: unknown;
}

/** What `getTransaction` (base64, maxSupportedTransactionVersion 1) returns; null = the RPC lost it. */
export type MockTransaction = {
  slot: number;
  blockTime: number | null;
  /** `loadedAddresses`: what a v0 transaction loaded from lookup tables, as the RPC reports it. */
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } };
  transaction: [string, "base64"];
  version: number | "legacy";
} | null;

/** Minimal in-memory implementation of the `Connection` methods the SDK uses. */
export class MockConnection {
  readonly accounts = new Map<string, MockAccount>();
  blockhash = "11111111111111111111111111111111";
  lastValidBlockHeight = 1_000;
  slot = 400_000_000;
  blockTime = 1_800_000_000;
  calls: string[] = [];
  simulate: ((tx: unknown, config: unknown) => unknown) | null = null;
  programAccountsError: Error | null = null;
  /** Address (base58) -> signatures, newest first. */
  readonly history = new Map<string, MockSignature[]>();
  /** Signature -> raw transaction. */
  readonly transactions = new Map<string, MockTransaction>();
  /** Raw JSON-RPC methods other than `getTransaction` (e.g. v1 `simulateTransaction`). */
  rpc: ((method: string, args: unknown[]) => unknown) | null = null;

  set(address: PublicKey, account: MockAccount): this {
    this.accounts.set(address.toBase58(), account);
    return this;
  }

  delete(address: PublicKey): this {
    this.accounts.delete(address.toBase58());
    return this;
  }

  get(address: PublicKey): MockAccount | undefined {
    const a = this.accounts.get(address.toBase58());
    // The simulated cluster clock read last stands in for this device's clock (test/setup.ts): the SDK's clock check
    // (audit 4, ID-F1b) then sees an honest RPC. Tests of the check pass their own `localNowSecs`.
    if (a !== undefined && address.toBase58() === CLOCK_SYSVAR && a.data.length >= 40) {
      (globalThis as { __noisedMockClock?: bigint }).__noisedMockClock = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigInt64(32, true);
    }
    return a;
  }

  private info(a: MockAccount | undefined): AccountInfo<Buffer> | null {
    if (a === undefined) return null;
    return { owner: a.owner, data: Buffer.from(a.data), lamports: a.lamports ?? 1_000_000, executable: a.executable ?? false, rentEpoch: 0 };
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null> {
    this.calls.push("getAccountInfo");
    return this.info(this.get(address));
  }

  /** Used by Anchor's account clients (the Meteora SDK). */
  async getAccountInfoAndContext(address: PublicKey): Promise<{ context: { slot: number }; value: AccountInfo<Buffer> | null }> {
    return { context: { slot: this.slot }, value: this.info(this.get(address)) };
  }

  async getMultipleAccountsInfo(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    this.calls.push("getMultipleAccountsInfo");
    if (addresses.length > 100) throw new Error("too many accounts in one request");
    return addresses.map((a) => this.info(this.get(a)));
  }

  /** The config of every `getMultipleAccountsInfoAndContext` / `getTokenAccountsByOwner` call, in order (commitment, minContextSlot). */
  readonly readConfigs: { method: string; keys: number; config: unknown }[] = [];

  async getMultipleAccountsInfoAndContext(addresses: PublicKey[], config?: unknown): Promise<{ context: { slot: number }; value: (AccountInfo<Buffer> | null)[] }> {
    this.calls.push("getMultipleAccountsInfoAndContext");
    this.readConfigs.push({ method: "getMultipleAccountsInfoAndContext", keys: addresses.length, config });
    if (addresses.length > 100) throw new Error("too many accounts in one request");
    return { context: { slot: this.slot }, value: addresses.map((a) => this.info(this.get(a))) };
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: this.blockhash, lastValidBlockHeight: this.lastValidBlockHeight };
  }

  async getBalance(address: PublicKey): Promise<number> {
    return this.get(address)?.lamports ?? 0;
  }

  /** Rent at the default (3,480 lamports per byte-year, two years). */
  async getMinimumBalanceForRentExemption(size: number): Promise<number> {
    return (128 + size) * 3_480 * 2;
  }

  async getSlot(): Promise<number> {
    return this.slot;
  }

  /** A local cluster's genesis hash by default (neither mainnet's nor devnet's); set it to test cluster checks. */
  genesisHash = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";

  async getGenesisHash(): Promise<string> {
    this.calls.push("getGenesisHash");
    return this.genesisHash;
  }

  async getBlockTime(): Promise<number> {
    return this.blockTime;
  }

  async getFeeForMessage(): Promise<{ context: { slot: number }; value: number }> {
    return { context: { slot: this.slot }, value: 5_000 };
  }

  async getTokenAccountsByOwner(owner: PublicKey, filter: { programId: PublicKey }, config?: unknown): Promise<{ context: { slot: number }; value: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] }> {
    this.calls.push("getTokenAccountsByOwner");
    this.readConfigs.push({ method: "getTokenAccountsByOwner", keys: 1, config });
    const value: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = [];
    for (const [k, a] of this.accounts) {
      if (!a.owner.equals(filter.programId) || a.data.length < 165) continue;
      if (!new PublicKey(a.data.slice(32, 64)).equals(owner)) continue;
      value.push({ pubkey: new PublicKey(k), account: this.info(a)! });
    }
    return { context: { slot: this.slot }, value };
  }

  async getProgramAccounts(programId: PublicKey, config?: { filters?: GetProgramAccountsFilter[] }): Promise<{ pubkey: PublicKey; account: AccountInfo<Buffer> }[]> {
    this.calls.push("getProgramAccounts");
    if (this.programAccountsError !== null) throw this.programAccountsError;
    const out: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = [];
    for (const [k, a] of this.accounts) {
      if (!a.owner.equals(programId)) continue;
      const ok = (config?.filters ?? []).every((f) => {
        if ("dataSize" in f) return a.data.length === f.dataSize;
        if ("memcmp" in f) {
          const bytes = decodeBase58(f.memcmp.bytes);
          const slice = a.data.slice(f.memcmp.offset, f.memcmp.offset + bytes.length);
          return slice.length === bytes.length && slice.every((b, i) => b === bytes[i]);
        }
        return true;
      });
      if (ok) out.push({ pubkey: new PublicKey(k), account: this.info(a)! });
    }
    return out;
  }

  /**
   * Record a landed transaction (wire bytes) as the newest entry of the
   * history of every address it names. `err` non-null = it failed.
   */
  addTransaction(signature: string, wire: Uint8Array, addresses: readonly PublicKey[], err: unknown = null, slot = this.slot): this {
    this.transactions.set(signature, { slot, blockTime: this.blockTime, meta: { err }, transaction: [Buffer.from(wire).toString("base64"), "base64"], version: wire[0] === 0x81 ? 1 : "legacy" });
    for (const a of new Set(addresses.map((k) => k.toBase58()))) {
      const list = this.history.get(a) ?? [];
      list.unshift({ signature, slot, err });
      this.history.set(a, list);
    }
    return this;
  }

  /** Newest first; `before` and `until` are exclusive, as on the RPC. */
  async getSignaturesForAddress(address: PublicKey, opts?: { limit?: number; before?: string; until?: string }): Promise<(MockSignature & { memo: null; blockTime: number | null })[]> {
    this.calls.push("getSignaturesForAddress");
    const all = this.history.get(address.toBase58()) ?? [];
    let start = 0;
    if (opts?.before !== undefined) {
      const i = all.findIndex((h) => h.signature === opts.before);
      start = i < 0 ? all.length : i + 1;
    }
    let end = all.length;
    if (opts?.until !== undefined) {
      const i = all.findIndex((h) => h.signature === opts.until);
      if (i >= 0) end = i;
    }
    return all
      .slice(start, Math.max(start, end))
      .slice(0, opts?.limit ?? 1_000)
      .map((h) => ({ ...h, memo: null, blockTime: this.blockTime }));
  }

  /** web3.js's internal JSON-RPC client (raw transactions, raw simulation). */
  async _rpcRequest(method: string, args: unknown[]): Promise<unknown> {
    this.calls.push(method);
    if (method === "getTransaction") return { result: this.transactions.get(args[0] as string) ?? null };
    if (this.rpc !== null) return this.rpc(method, args);
    throw new Error(`_rpcRequest ${method} not mocked`);
  }

  async simulateTransaction(tx: unknown, config: unknown): Promise<unknown> {
    if (this.simulate === null) throw new Error("simulateTransaction not mocked");
    return this.simulate(tx, config);
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

// ------------------------------------------------------- token accounts ---

function cOption(k: PublicKey | null): Uint8Array {
  return k === null ? new Uint8Array(36) : concatBytes([u32le(1), k.toBytes()]);
}

export interface TlvSpec {
  type: number;
  data: Uint8Array;
}

/** Raw mint bytes. With `extensions` (or `forceExtensionLayout`) the Token-2022 layout is used. */
export function mintBytes(o: {
  mintAuthority?: PublicKey | null;
  freezeAuthority?: PublicKey | null;
  supply?: bigint;
  decimals?: number;
  initialized?: boolean;
  extensions?: TlvSpec[];
  trailing?: Uint8Array;
}): Uint8Array {
  const base = concatBytes([
    cOption(o.mintAuthority ?? null),
    u64le(o.supply ?? 1_000_000_000_000_000n),
    Uint8Array.of(o.decimals ?? 6, o.initialized === false ? 0 : 1),
    cOption(o.freezeAuthority ?? null),
  ]);
  if (o.extensions === undefined) return base;
  const out = concatBytes([base, new Uint8Array(165 - 82), Uint8Array.of(1), ...o.extensions.map(tlv), o.trailing ?? new Uint8Array(0)]);
  // Token-2022 `adjust_len_for_multisig`: a mint is never exactly the multisig size (355).
  return out.length === 355 ? concatBytes([out, new Uint8Array(2)]) : out;
}

export function tokenAccountBytes(o: { mint: PublicKey; owner: PublicKey; amount: bigint; state?: number; token2022?: boolean; extensions?: TlvSpec[] }): Uint8Array {
  const base = concatBytes([
    o.mint.toBytes(),
    o.owner.toBytes(),
    u64le(o.amount),
    new Uint8Array(36), // delegate None
    Uint8Array.of(o.state ?? 1),
    new Uint8Array(12), // is_native None
    u64le(0n), // delegated amount
    new Uint8Array(36), // close authority None
  ]);
  if (o.token2022 !== true) return base;
  return concatBytes([base, Uint8Array.of(2), ...(o.extensions ?? []).map(tlv)]);
}

function tlv(e: TlvSpec): Uint8Array {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint16(0, e.type, true);
  new DataView(head.buffer).setUint16(2, e.data.length, true);
  return concatBytes([head, e.data]);
}

const zero32 = new Uint8Array(32);
const opt = (k: PublicKey | null): Uint8Array => (k === null ? zero32 : k.toBytes());

function str(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  return concatBytes([u32le(b.length), b]);
}

export const ext = {
  transferHook: (authority: PublicKey | null, program: PublicKey | null): TlvSpec => ({ type: 14, data: concatBytes([opt(authority), opt(program)]) }),
  metadataPointer: (authority: PublicKey | null, address: PublicKey | null): TlvSpec => ({ type: 18, data: concatBytes([opt(authority), opt(address)]) }),
  tokenMetadata: (o: { updateAuthority: PublicKey | null; mint: PublicKey; name: string; symbol: string; uri: string }): TlvSpec => ({
    type: 19,
    data: concatBytes([opt(o.updateAuthority), o.mint.toBytes(), str(o.name), str(o.symbol), str(o.uri), u32le(0)]),
  }),
  transferFeeConfig: (config: PublicKey | null, withdraw: PublicKey | null, bps = 0): TlvSpec => {
    const fee = (b: number): Uint8Array => {
      const f = new Uint8Array(18);
      new DataView(f.buffer).setBigUint64(8, 1_000_000n, true);
      new DataView(f.buffer).setUint16(16, b, true);
      return f;
    };
    return { type: 1, data: concatBytes([opt(config), opt(withdraw), u64le(0n), fee(bps), fee(bps)]) };
  },
  permanentDelegate: (delegate: PublicKey | null): TlvSpec => ({ type: 12, data: opt(delegate) }),
  nonTransferable: (): TlvSpec => ({ type: 9, data: new Uint8Array(0) }),
  mintCloseAuthority: (a: PublicKey | null): TlvSpec => ({ type: 3, data: opt(a) }),
  pausable: (authority: PublicKey | null, paused = false): TlvSpec => ({ type: 26, data: concatBytes([opt(authority), Uint8Array.of(paused ? 1 : 0)]) }),
  defaultAccountState: (state: number): TlvSpec => ({ type: 6, data: Uint8Array.of(state) }),
  /** Token-account extension: ImmutableOwner (every Token-2022 ATA has it). */
  immutableOwner: (): TlvSpec => ({ type: 7, data: new Uint8Array(0) }),
  /** Token-account extension: MemoTransfer. */
  memoTransfer: (required: boolean): TlvSpec => ({ type: 8, data: Uint8Array.of(required ? 1 : 0) }),
  /** Token-account extension: ConfidentialTransferAccount (295 bytes; byte 262 = allow_non_confidential_credits). */
  confidentialAccount: (allowNonConfidentialCredits: boolean): TlvSpec => {
    const d = new Uint8Array(295);
    d[0] = 1; // approved
    d[261] = 1; // allow_confidential_credits
    d[262] = allowNonConfidentialCredits ? 1 : 0;
    return { type: 5, data: d };
  },
  raw: (type: number, data: Uint8Array = new Uint8Array(0)): TlvSpec => ({ type, data }),
};

export const T22 = KNOWN_ACCOUNTS.token2022;
export const SPL = KNOWN_ACCOUNTS.splToken;

/** Loader-v3 program account + ProgramData account bytes. */
export function upgradeableProgram(conn: MockConnection, program: PublicKey, programData: PublicKey, slot: bigint, authority: PublicKey | null): void {
  conn.set(program, { owner: KNOWN_ACCOUNTS.bpfLoaderUpgradeable, data: concatBytes([u32le(2), programData.toBytes()]), executable: true });
  conn.set(programData, {
    owner: KNOWN_ACCOUNTS.bpfLoaderUpgradeable,
    data: concatBytes([u32le(3), u64le(slot), authority === null ? new Uint8Array(33) : concatBytes([Uint8Array.of(1), authority.toBytes()]), new Uint8Array(16)]),
  });
}

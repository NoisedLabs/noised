/**
 * Test helpers, ported from the SDK's own test suite (sdk/test/helpers.ts):
 * an in-memory `Connection` and raw SPL Token / Token-2022 account bytes laid
 * out exactly like the token programs write them. Only the SDK's public API
 * is used.
 */
import { createHash } from "node:crypto";

import { decodeBase58, KNOWN_ACCOUNTS } from "@noisedlabs/sdk";
import { Keypair, PublicKey, type AccountInfo, type Connection, type GetProgramAccountsFilter } from "@solana/web3.js";

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/** A deterministic, distinct public key per label (32 label bytes: often off the curve, like a PDA). */
export function key(label: string): PublicKey {
  return new PublicKey(new TextEncoder().encode(label.padEnd(32, "#").slice(0, 32)));
}

/** A deterministic wallet address per label: a keypair's public key (on the curve), as a graph payee must be. */
export function wallet(label: string): PublicKey {
  return Keypair.fromSeed(new Uint8Array(createHash("sha256").update(label).digest())).publicKey;
}

export interface MockAccount {
  owner: PublicKey;
  data: Uint8Array;
  lamports?: number;
  executable?: boolean;
}

/** The genesis hashes of the public clusters (the SDK's GENESIS_HASHES). */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Minimal in-memory implementation of the `Connection` methods the SDK and this server use. */
export class MockConnection {
  readonly accounts = new Map<string, MockAccount>();
  blockhash = "11111111111111111111111111111111";
  lastValidBlockHeight = 1_000;
  slot = 400_000_000;
  calls: string[] = [];
  /** A local cluster's genesis hash by default (neither mainnet's nor devnet's). */
  genesisHash = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";
  /** What `simulateTransaction` answers (default: success). */
  simulate: (tx: unknown, config: unknown) => unknown = () => ({ context: { slot: this.slot }, value: { err: null, logs: ["Program log: simulated"], unitsConsumed: 42_000 } });
  readonly simulated: unknown[] = [];

  set(address: PublicKey, account: MockAccount): this {
    this.accounts.set(address.toBase58(), account);
    return this;
  }

  get(address: PublicKey): MockAccount | undefined {
    return this.accounts.get(address.toBase58());
  }

  private info(a: MockAccount | undefined): AccountInfo<Buffer> | null {
    if (a === undefined) return null;
    return { owner: a.owner, data: Buffer.from(a.data), lamports: a.lamports ?? 1_000_000, executable: a.executable ?? false, rentEpoch: 0 };
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null> {
    this.calls.push("getAccountInfo");
    return this.info(this.get(address));
  }

  async getAccountInfoAndContext(address: PublicKey): Promise<{ context: { slot: number }; value: AccountInfo<Buffer> | null }> {
    return { context: { slot: this.slot }, value: this.info(this.get(address)) };
  }

  async getMultipleAccountsInfo(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    this.calls.push("getMultipleAccountsInfo");
    if (addresses.length > 100) throw new Error("too many accounts in one request");
    return addresses.map((a) => this.info(this.get(a)));
  }

  async getMultipleAccountsInfoAndContext(addresses: PublicKey[]): Promise<{ context: { slot: number }; value: (AccountInfo<Buffer> | null)[] }> {
    this.calls.push("getMultipleAccountsInfoAndContext");
    return { context: { slot: this.slot }, value: addresses.map((a) => this.info(this.get(a))) };
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: this.blockhash, lastValidBlockHeight: this.lastValidBlockHeight };
  }

  async getBalance(address: PublicKey): Promise<number> {
    return this.get(address)?.lamports ?? 0;
  }

  async getSlot(): Promise<number> {
    return this.slot;
  }

  async getGenesisHash(): Promise<string> {
    this.calls.push("getGenesisHash");
    return this.genesisHash;
  }

  async getBlockTime(): Promise<number> {
    return 1_800_000_000;
  }

  async getFeeForMessage(): Promise<{ context: { slot: number }; value: number }> {
    return { context: { slot: this.slot }, value: 5_000 };
  }

  async getMinimumBalanceForRentExemption(size: number): Promise<number> {
    return 890_880 + size * 6_960;
  }

  async getTokenAccountsByOwner(owner: PublicKey, filter: { programId: PublicKey }): Promise<{ context: { slot: number }; value: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] }> {
    this.calls.push("getTokenAccountsByOwner");
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
    const out: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = [];
    for (const [k, a] of this.accounts) {
      if (!a.owner.equals(programId)) continue;
      const ok = (config?.filters ?? []).every((f) => {
        if ("dataSize" in f) return a.data.length === f.dataSize;
        if ("memcmp" in f) {
          const bytes = decodeBase58(f.memcmp.bytes);
          if (bytes === null) return false;
          const slice = a.data.slice(f.memcmp.offset, f.memcmp.offset + bytes.length);
          return slice.length === bytes.length && slice.every((b, i) => b === bytes[i]);
        }
        return true;
      });
      if (ok) out.push({ pubkey: new PublicKey(k), account: this.info(a)! });
    }
    return out;
  }

  async simulateTransaction(tx: unknown, config: unknown): Promise<unknown> {
    this.calls.push("simulateTransaction");
    this.simulated.push(tx);
    return this.simulate(tx, config);
  }

  async _rpcRequest(method: string): Promise<unknown> {
    throw new Error(`_rpcRequest ${method} not mocked`);
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

/** Raw mint bytes. With `extensions` the Token-2022 layout is used. */
export function mintBytes(o: { mintAuthority?: PublicKey | null; freezeAuthority?: PublicKey | null; supply?: bigint; decimals?: number; extensions?: TlvSpec[] }): Uint8Array {
  const base = concatBytes([cOption(o.mintAuthority ?? null), u64le(o.supply ?? 1_000_000_000_000_000n), Uint8Array.of(o.decimals ?? 6, 1), cOption(o.freezeAuthority ?? null)]);
  if (o.extensions === undefined) return base;
  const out = concatBytes([base, new Uint8Array(165 - 82), Uint8Array.of(1), ...o.extensions.map(tlv)]);
  return out.length === 355 ? concatBytes([out, new Uint8Array(2)]) : out;
}

export function tokenAccountBytes(o: { mint: PublicKey; owner: PublicKey; amount: bigint; token2022?: boolean }): Uint8Array {
  const base = concatBytes([o.mint.toBytes(), o.owner.toBytes(), u64le(o.amount), new Uint8Array(36), Uint8Array.of(1), new Uint8Array(12), u64le(0n), new Uint8Array(36)]);
  if (o.token2022 !== true) return base;
  return concatBytes([base, Uint8Array.of(2)]);
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

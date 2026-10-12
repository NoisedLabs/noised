/** Account reads with bounded batches and explicit owner checks. */
import type { AccountInfo, Commitment, Connection, PublicKey } from "@solana/web3.js";

/** `getMultipleAccountsInfo` limit per request. */
const BATCH = 100;

export interface RawAccount {
  address: PublicKey;
  owner: PublicKey;
  lamports: number;
  executable: boolean;
  data: Uint8Array;
}

function toRaw(address: PublicKey, info: AccountInfo<Buffer | Uint8Array> | null): RawAccount | null {
  if (info === null) return null;
  return {
    address,
    owner: info.owner,
    lamports: info.lamports,
    executable: info.executable,
    data: new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength),
  };
}

export async function getAccount(conn: Connection, address: PublicKey, commitment: Commitment = "confirmed"): Promise<RawAccount | null> {
  return toRaw(address, await conn.getAccountInfo(address, commitment));
}

/** Fetch many accounts (in order); missing accounts are null. */
export async function getAccounts(conn: Connection, addresses: readonly PublicKey[], commitment: Commitment = "confirmed"): Promise<(RawAccount | null)[]> {
  const out: (RawAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const infos = await conn.getMultipleAccountsInfo([...chunk], commitment);
    if (infos.length !== chunk.length) throw new Error("RPC returned a different number of accounts than requested");
    chunk.forEach((address, j) => out.push(toRaw(address, infos[j] ?? null)));
  }
  return out;
}

/**
 * An account that exists with data and is owned by `program`; null when it
 * does not exist or only holds lamports (anyone can send SOL to an address).
 * Throws if it exists with data under another owner.
 */
export function ownedBy(acc: RawAccount | null, program: PublicKey, what: string): RawAccount | null {
  if (acc === null) return null;
  if (acc.data.length === 0 && !acc.owner.equals(program)) return null;
  if (!acc.owner.equals(program)) throw new Error(`${what} ${acc.address.toBase58()} is owned by ${acc.owner.toBase58()}, expected ${program.toBase58()}`);
  return acc;
}

/** A JSON-RPC response as web3.js 1.x's internal client returns it. */
export interface RpcResponse<T = unknown> {
  result?: T;
  error?: { code?: number; message: string };
}

export type RpcRequest = <T = unknown>(method: string, args: unknown[]) => Promise<RpcResponse<T>>;

/**
 * web3.js 1.x has no public API for raw-bytes simulation or for reading v1
 * transactions; use its internal JSON-RPC client.
 */
export function rpcRequest(conn: Connection): RpcRequest {
  const f = (conn as unknown as { _rpcRequest?: (method: string, args: unknown[]) => Promise<RpcResponse> })._rpcRequest;
  if (typeof f !== "function") throw new Error("this Connection cannot send raw JSON-RPC requests");
  const bound = f.bind(conn);
  return async <T>(method: string, args: unknown[]): Promise<RpcResponse<T>> => (await bound(method, args)) as RpcResponse<T>;
}

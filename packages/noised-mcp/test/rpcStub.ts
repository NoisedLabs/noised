/**
 * A local JSON-RPC endpoint serving a MockConnection's accounts over HTTP, in
 * the RPC's own response shapes, so the built server's real web3.js
 * `Connection` (parsing, base64 decoding, simulation) is exercised end to end
 * without any network.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { PublicKey, type GetProgramAccountsFilter } from "@solana/web3.js";

import type { MockConnection } from "./helpers.js";

type Rpc = { id: unknown; method: string; params?: unknown[] };

function account(conn: MockConnection, address: string): unknown {
  const a = conn.accounts.get(address);
  if (a === undefined) return null;
  return { data: [Buffer.from(a.data).toString("base64"), "base64"], executable: a.executable ?? false, lamports: a.lamports ?? 1_000_000, owner: a.owner.toBase58(), rentEpoch: 0, space: a.data.length };
}

export async function startRpcStub(conn: MockConnection): Promise<{ url: string; server: Server; methods: string[] }> {
  const methods: string[] = [];
  const ctx = { apiVersion: "2.2.0", slot: conn.slot };
  const handle = async (m: Rpc): Promise<unknown> => {
    methods.push(m.method);
    const p = m.params ?? [];
    switch (m.method) {
      case "getGenesisHash":
        return conn.genesisHash;
      case "getAccountInfo":
        return { context: ctx, value: account(conn, p[0] as string) };
      case "getMultipleAccounts":
        return { context: ctx, value: (p[0] as string[]).map((a) => account(conn, a)) };
      case "getProgramAccounts": {
        const cfg = (p[1] ?? {}) as { filters?: GetProgramAccountsFilter[] };
        const list = await conn.getProgramAccounts(new PublicKey(p[0] as string), cfg.filters === undefined ? {} : { filters: cfg.filters });
        return list.map((x) => ({ pubkey: x.pubkey.toBase58(), account: account(conn, x.pubkey.toBase58()) }));
      }
      case "getLatestBlockhash":
        return { context: ctx, value: { blockhash: conn.blockhash, lastValidBlockHeight: conn.lastValidBlockHeight } };
      case "getFeeForMessage":
        return { context: ctx, value: 5_000 };
      case "getMinimumBalanceForRentExemption":
        return await conn.getMinimumBalanceForRentExemption(p[0] as number);
      case "simulateTransaction": {
        const r = (await conn.simulate(p[0], p[1])) as { value: { err: unknown; logs: string[]; unitsConsumed: number } };
        return { context: ctx, value: { err: r.value.err, logs: r.value.logs, unitsConsumed: r.value.unitsConsumed, accounts: null, returnData: null } };
      }
      default:
        throw new Error(`method ${m.method} not stubbed`);
    }
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const one = async (m: Rpc): Promise<unknown> => {
        try {
          return { jsonrpc: "2.0", id: m.id, result: await handle(m) };
        } catch (e) {
          return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: e instanceof Error ? e.message : String(e) } };
        }
      };
      const msg = JSON.parse(body) as Rpc | Rpc[];
      void (Array.isArray(msg) ? Promise.all(msg.map(one)) : one(msg)).then((out) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, methods };
}

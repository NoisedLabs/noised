/**
 * The built server (dist/index.js) end to end over stdio, against a tiny
 * local JSON-RPC stub (no network): it starts on localnet, lists its tools
 * and answers a call; it refuses to start on mainnet without the opt-in or
 * when the endpoint is not the configured cluster. Skipped until `pnpm build`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEVNET_GENESIS } from "./helpers.js";

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const LOCAL_GENESIS = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";

let rpc: Server;
let url = "";
let genesis = LOCAL_GENESIS;

beforeAll(async () => {
  rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const one = (m: { id: unknown; method: string }): unknown => {
        const result =
          m.method === "getGenesisHash"
            ? genesis
            : m.method === "getProgramAccounts"
              ? []
              : m.method === "getAccountInfo"
                ? { context: { slot: 1 }, value: null }
                : m.method === "getMultipleAccounts"
                  ? { context: { slot: 1 }, value: [] }
                  : null;
        return { jsonrpc: "2.0", id: m.id, result };
      };
      const msg = JSON.parse(body) as { id: unknown; method: string } | { id: unknown; method: string }[];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
});

afterAll(() => {
  rpc.close();
});

const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return env;
};

describe.skipIf(!existsSync(DIST))("built server over stdio", () => {
  it("starts on localnet, lists eleven tools, answers list_launches", async () => {
    genesis = LOCAL_GENESIS;
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST], env: { ...baseEnv(), NOISED_CLUSTER: "localnet", NOISED_RPC_URL: url }, stderr: "pipe" });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(11);
      const r = (await client.callTool({ name: "list_launches", arguments: {} })) as CallToolResult;
      expect(r.isError ?? false).toBe(false);
      expect((r.content as { text: string }[])[0]!.text).toMatch(/^0 launch\(es\)/);
    } finally {
      await client.close();
    }
  });

  it("refuses to start: mainnet without NOISED_ALLOW_MAINNET=1, or an endpoint serving another cluster", async () => {
    // Asynchronous: the JSON-RPC stub runs in this process and must keep answering.
    const run = (env: Record<string, string>): Promise<{ status: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [DIST], { env: { ...baseEnv(), ...env }, stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
        const timer = setTimeout(() => child.kill(), 30_000);
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ status, stderr });
        });
      });
    const mainnet = await run({ NOISED_CLUSTER: "mainnet", NOISED_RPC_URL: url });
    expect(mainnet.status).toBe(2);
    expect(mainnet.stderr).toMatch(/refusing to start on mainnet/);
    genesis = DEVNET_GENESIS;
    const wrong = await run({ NOISED_CLUSTER: "localnet", NOISED_RPC_URL: url });
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/wrong cluster: configured for localnet, but the endpoint serves devnet/);
    genesis = LOCAL_GENESIS;
  });
});

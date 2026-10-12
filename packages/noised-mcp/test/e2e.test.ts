/**
 * End to end, no network: the built server (dist/index.js) over stdio, with
 * a real web3.js Connection to a local JSON-RPC stub serving the mocked
 * world. Covers the read and build paths through the real RPC client, and
 * the keeper example (examples/langgraph-operator, once built) driving it.
 * Skipped until `pnpm build` (and the example's build) have run.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Transaction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { key } from "./helpers.js";
import { startRpcStub } from "./rpcStub.js";
import { OPERATOR, world } from "./world.js";

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const KEEPER = fileURLToPath(new URL("../examples/langgraph-operator/dist/keeper.js", import.meta.url));

const w = world();
let stub: { url: string; server: Server; methods: string[] };

beforeAll(async () => {
  stub = await startRpcStub(w.conn);
});
afterAll(() => {
  stub.server.close();
});

const env = (): Record<string, string> => {
  const e: Record<string, string> = { NOISED_CLUSTER: "localnet", NOISED_RPC_URL: stub.url };
  for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME"]) if (process.env[k] !== undefined) e[k] = process.env[k]!;
  return e;
};

describe.skipIf(!existsSync(DIST))("built server against a JSON-RPC endpoint", () => {
  it("reads the autopilot and builds an operator run through a real Connection", async () => {
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST], env: env(), stderr: "pipe" }));
    try {
      const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
      const ap = await call("get_autopilot", { launch: w.launch.toBase58() });
      expect(ap.isError ?? false).toBe(false);
      expect(ap.structuredContent).toMatchObject({ due: [0, 1, 2, 3], operator: OPERATOR.toBase58() });
      const run = await call("build_run_tx", { launch: w.launch.toBase58(), node: 3, caller: OPERATOR.toBase58(), operator: OPERATOR.toBase58(), amount: "100000000" });
      expect(run.isError ?? false).toBe(false);
      const data = run.structuredContent as { unsignedTransaction: { base64: string; signersRequired: string[] }; simulation: { ok: boolean }; costs: Record<string, unknown> };
      expect(data.simulation.ok).toBe(true);
      // The SDK's RunCosts through a real Connection: the caller's own tip account at the endpoint's rent.
      expect(data.costs).toEqual({ signatureFeeLamports: "5000", priorityFeeLamports: "0", rentLamports: "2039280", totalLamports: "2044280", signatures: 1 });
      expect(data.unsignedTransaction.signersRequired).toEqual([OPERATOR.toBase58()]);
      const tx = Transaction.from(Buffer.from(data.unsignedTransaction.base64, "base64"));
      expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
      const refused = await call("build_run_tx", { launch: w.launch.toBase58(), node: 3, caller: OPERATOR.toBase58(), operator: OPERATOR.toBase58(), amount: "500000001" });
      expect(refused.isError).toBe(true);
      expect(stub.methods).toEqual(expect.arrayContaining(["getGenesisHash", "getAccountInfo", "getMultipleAccounts", "getLatestBlockhash", "simulateTransaction"]));
    } finally {
      await client.close();
    }
  });

  it.skipIf(!existsSync(KEEPER))("the keeper example emits one unsigned transaction per keeper step (none for the operator's)", async () => {
    const keeper = key("e2e/keeper").toBase58();
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [KEEPER], { env: { ...env(), NOISED_LAUNCH: w.launch.toBase58(), NOISED_KEEPER: keeper } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      const t = setTimeout(() => child.kill(), 60_000);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ code, stdout, stderr });
      });
    });
    expect(out.code, out.stderr).toBe(0);
    const lines = out.stdout.trim().split("\n").map((l) => JSON.parse(l) as { kind: string; node: number; signersRequired: string[]; simulationOk: boolean; unsignedTxBase64: string });
    expect(lines.map((l) => l.node)).toEqual([0, 1, 2]);
    for (const l of lines) {
      expect(l).toMatchObject({ kind: "run", signersRequired: [keeper], simulationOk: true });
      expect(Transaction.from(Buffer.from(l.unsignedTxBase64, "base64")).signatures.every((s) => s.signature === null)).toBe(true);
    }
  });
});

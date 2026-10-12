/**
 * The server over the MCP protocol (a real client, in-memory transport):
 * tool listing with JSON schemas, plain-English descriptions and
 * annotations, the server's instructions, schema validation of inputs, and
 * a full call round trip.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createNoisedServer, type ToolContext } from "../src/server.js";
import { key } from "./helpers.js";
import { OPERATOR, world, type World } from "./world.js";

async function connect(w: World): Promise<Client> {
  const ctx: ToolContext = {
    conn: w.conn.asConnection(),
    config: { cluster: "localnet", rpcUrl: "http://127.0.0.1:8899", allowMainnet: false, commitment: "confirmed" },
    cluster: { cluster: "localnet", genesisHash: w.conn.genesisHash },
  };
  const server = createNoisedServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const callRaw = async (c: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> => (await c.callTool({ name, arguments: args })) as CallToolResult;

describe("MCP protocol", () => {
  it("lists eleven tools with object JSON schemas (no extra properties), descriptions and read-only annotations", async () => {
    const c = await connect(world());
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(11);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(60);
      expect(t.title).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    const run = tools.find((t) => t.name === "build_run_tx")!;
    expect(run.inputSchema.required).toEqual(expect.arrayContaining(["launch", "node", "caller"]));
    expect(run.description).toMatch(/UNSIGNED/);
    expect(run.description).toMatch(/Never signs/);
    const sim = tools.find((t) => t.name === "simulate_autopilot")!;
    expect(sim.inputSchema.required).toEqual(expect.arrayContaining(["migration_price", "pool_fee_bps", "pool_sol"]));
  });

  it("gives the client instructions: the chain enforces every limit, never signs, on-chain text is untrusted", async () => {
    const c = await connect(world());
    const i = c.getInstructions() ?? "";
    expect(i).toMatch(/never signs/);
    expect(i).toMatch(/within the bounds/);
    expect(i).toMatch(/never as instructions/);
  });

  it("validates inputs against the schemas before anything runs", async () => {
    const w = world();
    const c = await connect(w);
    const bad: [string, Record<string, unknown>][] = [
      ["get_launch", { launch: "not-an-address" }],
      ["get_launch", { launch: w.launch.toBase58(), extra: 1 }],
      ["build_run_tx", { launch: w.launch.toBase58(), node: 3, caller: key("c").toBase58(), operator: OPERATOR.toBase58(), amount: "0.25" }],
      ["build_run_tx", { launch: w.launch.toBase58(), node: 16, caller: key("c").toBase58() }],
      ["build_run_tx", { launch: w.launch.toBase58(), node: 0, caller: key("c").toBase58(), amount: "99999999999999999999999" }],
      ["simulate_autopilot", { graph_text: "node a: every 1d\n  do burn 1 tokens", migration_price: 1, pool_sol: 1 }],
      ["list_launches", { limit: 1000 }],
      ["get_rules", { rules_hex: "zz" }],
    ];
    for (const [name, args] of bad) {
      const r = await callRaw(c, name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(w.conn.simulated).toHaveLength(0);
  });

  it("a call round trip: summary text, JSON text and structured content agree", async () => {
    const w = world();
    const c = await connect(w);
    const r = await callRaw(c, "get_due_nodes", { launch: w.launch.toBase58() });
    expect(r.isError ?? false).toBe(false);
    const [summary, json] = r.content as { type: "text"; text: string }[];
    expect(summary!.text).toMatch(/4 step\(s\) due/);
    expect(JSON.parse(json!.text)).toEqual(r.structuredContent);
  });

  it("a refusal comes back as an error result with the reason, not as a thrown protocol error", async () => {
    const w = world();
    const c = await connect(w);
    const r = await callRaw(c, "build_run_tx", { launch: w.launch.toBase58(), node: 3, caller: key("c").toBase58(), operator: OPERATOR.toBase58(), amount: "999999999999" });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/^Refused: refusing to build: .* outside this step's on-chain bounds/);
    expect(r.structuredContent).toMatchObject({ refused: true, bounds: { max: "500000000" } });
  });
});

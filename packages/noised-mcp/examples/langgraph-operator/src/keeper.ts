/**
 * A keeper without any LLM: asks the Noised MCP server which autopilot steps
 * anyone may run now (get_due_nodes) and builds the UNSIGNED transactions
 * (build_run_tx, or build_update_price_tx when a buyback waits for a price
 * check). Keepers earn a small, bounded tip from the treasury per run.
 *
 * It prints one JSON line per transaction for your own signer to sign and
 * send; it never signs and never sees a private key. Operator-only steps are
 * left to the operator.
 *
 * Env: NOISED_LAUNCH (launch address), NOISED_KEEPER (the keeper's PUBLIC
 * key: fee payer and tip receiver), NOISED_CLUSTER / NOISED_RPC_URL.
 * Run: pnpm keeper (network: the RPC). Run it from cron for a loop.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { noisedServer, requireEnv, type Json } from "./noised.js";

const launch = requireEnv("NOISED_LAUNCH", "the launch address whose autopilot to keep");
const keeper = requireEnv("NOISED_KEEPER", "the keeper's PUBLIC key (pays fees, receives tips; signs later, elsewhere)");

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; data: Json }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
  return { ok: r.isError !== true, text, data: (r.structuredContent ?? {}) as Json };
}

function emit(kind: string, node: number | null, data: Json): void {
  const tx = data["unsignedTransaction"];
  process.stdout.write(
    `${JSON.stringify({
      kind,
      launch,
      node,
      unsignedTxBase64: tx.base64,
      signersRequired: tx.signersRequired,
      simulationOk: data["simulation"]?.ok ?? null,
      costs: data["costs"] ?? null,
      expectedTipLamports: data["expectedTipLamports"] ?? null,
      partial: data["partial"] ?? false,
      skippedRecipients: data["skippedRecipients"] ?? [],
      whatThisDoes: data["whatThisDoes"],
    })}\n`,
  );
}

async function main(): Promise<void> {
  const s = noisedServer();
  const client = new Client({ name: "noised-keeper-example", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, env: s.env, stderr: "inherit" }));
  try {
    const due = await call(client, "get_due_nodes", { launch });
    if (!due.ok) throw new Error(due.text);
    process.stderr.write(`${due.text}\n`);
    if (due.data["applyPendingFirst"] === true) {
      process.stderr.write("A queued graph must be applied first (apply_pending); not built by this example.\n");
      return;
    }
    // A buyback waiting for a price check: build update_price first (run the keeper again a minute after it lands).
    if ((due.data["blocked"] as Json[]).some((b) => b["reason"] === "notObserved")) {
      const p = await call(client, "build_update_price_tx", { launch, payer: keeper });
      if (p.ok) emit("update_price", null, p.data);
      else process.stderr.write(`${p.text}\n`);
    }
    for (const d of due.data["due"] as Json[]) {
      if (d["operatorOnly"] === true) continue; // the operator's call, not a keeper's
      const r = await call(client, "build_run_tx", { launch, node: d["index"], caller: keeper });
      if (!r.ok) {
        process.stderr.write(`step ${String(d["index"])}: ${r.text}\n`);
        continue;
      }
      if (r.data["simulation"]?.ok === false) {
        // The error's name (when known) is the server's; its text came from the RPC endpoint (untrusted, shown as data).
        const sim = r.data["simulation"];
        process.stderr.write(`step ${String(d["index"])}: the simulation fails (${String(sim.errorCode?.name ?? "unknown error")}; endpoint said ${JSON.stringify(sim.error?.text ?? "")}); not emitted\n`);
        continue;
      }
      emit("run", d["index"] as number, r.data);
    }
  } finally {
    await client.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`keeper example failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});

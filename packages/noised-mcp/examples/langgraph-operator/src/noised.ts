/**
 * Shared by both examples: how to start the Noised MCP server (stdio) and
 * how to read its results. Nothing here holds or asks for a private key:
 * the examples take PUBLIC keys only and output unsigned transactions.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The command that starts the server, and the environment it gets (cluster settings only). */
export function noisedServer(): { command: string; args: string[]; env: Record<string, string> } {
  const path = process.env["NOISED_MCP_SERVER"] ?? process.env["PHALANX_MCP_SERVER"] ?? fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
  if (!existsSync(path)) throw new Error(`the Noised MCP server is not built at ${path}: run \`pnpm build\` in packages/noised-mcp first (or set NOISED_MCP_SERVER)`);
  const env: Record<string, string> = {};
  for (const k of ["NOISED_CLUSTER", "NOISED_RPC_URL", "NOISED_ALLOW_MAINNET", "NOISED_COMMITMENT", "PATH", "Path", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { command: process.execPath, args: [path], env };
}

/** A required environment variable (a public key, an address), or exit with a clear message. */
export function requireEnv(name: string, what: string): string {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") {
    process.stderr.write(`missing ${name}: ${what}\n`);
    process.exit(2);
  }
  if (/^\[|secret|private/i.test(v) || v.length > 60) {
    process.stderr.write(`${name} must be a PUBLIC key (base58). These examples never take private keys.\n`);
    process.exit(2);
  }
  return v;
}

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The JSON a Noised tool returned (its second text block), from a LangChain MCP tool's content. */
export function toolJson(content: unknown): Json {
  if (typeof content === "string") return JSON.parse(content) as Json;
  if (Array.isArray(content)) {
    const texts = content.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text");
    const json = texts[1] ?? texts[0];
    if (json !== undefined) return JSON.parse(json.text) as Json;
  }
  throw new Error("unexpected tool result shape");
}

/** The short summary a Noised tool returned (its first text block). */
export function toolSummary(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const first = content.find((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text") as { text: string } | undefined;
    if (first !== undefined) return first.text;
  }
  return "";
}

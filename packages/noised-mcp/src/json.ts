/**
 * JSON for tool results: bigints become decimal strings (u64 amounts do not
 * fit a JSON number), public keys base58, byte arrays hex. Nothing is lost
 * and every value is plain JSON.
 */
import { PublicKey } from "@solana/web3.js";

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function toJson(v: unknown): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof PublicKey) return v.toBase58();
  // A PublicKey from another copy of web3.js (instanceof fails across copies).
  if (typeof v === "object" && typeof (v as { toBase58?: unknown }).toBase58 === "function" && (v as { _bn?: unknown })._bn !== undefined) {
    return (v as { toBase58(): string }).toBase58();
  }
  if (v instanceof Uint8Array) return hex(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toJson);
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), toJson(x)]));
  if (typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || typeof x === "function") continue;
      out[k] = toJson(x);
    }
    return out;
  }
  return null;
}

/** JSON text of a tool result (bigint-safe). */
export function stringify(v: unknown): string {
  return JSON.stringify(toJson(v), null, 2);
}

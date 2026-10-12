/**
 * What every tool shares: the context (connection, configuration, cluster),
 * the result shape (a short plain-English summary + structured JSON), the
 * refusal error, and input parsing helpers.
 */
import { formatSol, formatTokens, sqrtPriceQ64ToPriceText } from "@noisedlabs/sdk";
import { PublicKey, type Connection } from "@solana/web3.js";
import { z } from "zod";

import type { ClusterInfo } from "../cluster.js";
import type { ServerConfig } from "../config.js";
import { readBoundRulesOnChain, type BoundRulesReader } from "../boundRules.js";
import { cleanText } from "../untrusted.js";

export interface ToolContext {
  conn: Connection;
  config: ServerConfig;
  /** The cluster the endpoint was found to serve at start. */
  cluster: ClusterInfo;
  /** How to read a launch's bound rules (default: the SDK's readers). Overridable for embedding and tests. */
  boundRules?: BoundRulesReader | undefined;
}

/** The bound-rules reader in effect. */
export function boundRulesReader(ctx: ToolContext): BoundRulesReader {
  return ctx.boundRules ?? readBoundRulesOnChain;
}

/** What a tool returns: a few plain-English lines and the full structured data. */
export interface ToolOutput {
  summary: string;
  data: Record<string, unknown>;
}

/**
 * The tool refuses: the request is outside what the chain would allow, or
 * unsafe or unclear. Nothing was built. `details` goes to the structured result.
 */
export class Refusal extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "Refusal";
    this.details = details;
  }
}

// ------------------------------------------------------------ schemas ---

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A Solana address (base58, 32 bytes). */
export const address = (what: string) =>
  z
    .string()
    .trim()
    .regex(BASE58, "must be a base58 Solana address")
    .refine((s) => {
      try {
        return new PublicKey(s).toBytes().length === 32;
      } catch {
        return false;
      }
    }, "must be a valid Solana address")
    .describe(what);

/** An unsigned 64-bit integer as a decimal string (raw units: lamports or raw token units). */
export const u64String = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, "must be a whole number written as digits")
    .refine((s) => BigInt(s) <= (1n << 64n) - 1n, "must fit in 64 bits")
    .describe(what);

/** A positive decimal number as a string or number (SOL, tokens, prices). */
export const decimal = (what: string) =>
  z
    .union([z.number().finite().nonnegative(), z.string().trim().regex(/^[0-9]+(\.[0-9]+)?$/, "must be a plain decimal number like 0.5")])
    .describe(what);

/** PXR1 / PXG1 bytes: base64 (standard alphabet). */
export const base64Bytes = (what: string, maxBytes: number) =>
  z
    .string()
    .trim()
    .max(Math.ceil((maxBytes * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64")
    .describe(what);

/** PXR1 / PXG1 bytes: hex. */
export const hexBytes = (what: string, maxBytes: number) =>
  z
    .string()
    .trim()
    .max(maxBytes * 2 + 2)
    .regex(/^(0x)?([0-9a-fA-F]{2})*$/, "must be hex")
    .describe(what);

// ------------------------------------------------------------ parsing ---

export const pubkey = (s: string): PublicKey => new PublicKey(s);

export function bytesFromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function bytesFromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.startsWith("0x") ? s.slice(2) : s, "hex"));
}

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

// ------------------------------------------------------------ formatting ---

export const sol = (lamports: bigint): string => `${formatSol(lamports, true)} SOL`;
export const tokens = (raw: bigint, decimals: number): string => `${formatTokens(raw, decimals, true)} tokens`;
export const priceText = (sqrtQ64: bigint, decimals: number): string => (sqrtQ64 === 0n ? "no price" : `${sqrtPriceQ64ToPriceText(sqrtQ64, decimals)} SOL per token`);

/** Unix seconds -> ISO 8601 (null for 0 = never). */
export function iso(unix: bigint | number): string | null {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An amount in a node's unit, in words. */
export function amountText(raw: bigint, unit: "lamports" | "tokens", decimals: number): string {
  return unit === "lamports" ? sol(raw) : tokens(raw, decimals);
}

/**
 * The error message of anything thrown, cleaned for display (visible characters only, capped). Only for errors this
 * server or the SDK wrote from data it checked; anything that may quote the RPC goes through `errorUntrusted`.
 */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return cleanText(m, 1_000).text;
}

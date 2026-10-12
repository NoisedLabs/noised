/**
 * Helpers shared by the examples (not part of the SDK): configuration from
 * environment variables, keypair and secret files, durable on-disk stores
 * for the leaf ledger and the LMS tree cache, and "simulate, then sign, then
 * send".
 *
 * Secrets are read from files, never from environment variables or command
 * line arguments (those end up in shell history and process listings).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { sendAndConfirm, simulateAndExplain, type Cluster, type LeafLedgerStore, type lms } from "@noisedlabs/sdk";

// ------------------------------------------------------------ configuration ---

/** A required environment variable (throws with its name when missing). */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new Error(`set ${name} (see the header of this example)`);
  return v.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

/** `RPC_URL` (required). */
export function connectionFromEnv(): Connection {
  return new Connection(requireEnv("RPC_URL"), "confirmed");
}

/**
 * `NOISED_CLUSTER` = mainnet | devnet (default) | localnet: the cluster the
 * post-quantum keys are derived for. The SDK checks it against the RPC's
 * genesis hash before every PQ signature; localnet needs an explicit opt-in.
 */
export function clusterFromEnv(): { cluster: Cluster; allowLocalnet: boolean } {
  const c = optionalEnv("NOISED_CLUSTER", "devnet");
  if (c !== "mainnet" && c !== "devnet" && c !== "localnet") throw new Error("NOISED_CLUSTER must be mainnet, devnet or localnet");
  return { cluster: c, allowLocalnet: c === "localnet" };
}

/** Optional priority fee (`CU_PRICE_MICROLAMPORTS`, micro-lamports per compute unit). */
export function computeUnitPriceFromEnv(): bigint | undefined {
  const v = process.env["CU_PRICE_MICROLAMPORTS"];
  return v === undefined || v.trim() === "" ? undefined : BigInt(v.trim());
}

/** A Solana CLI keypair file (a JSON array of 64 bytes). */
export function loadKeypair(path: string): Keypair {
  const bytes: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${path} is not a Solana CLI keypair file`);
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

/** A secret kept in a file (e.g. the 24-word PQ recovery phrase), trimmed. */
export function readSecretFile(path: string): string {
  return readFileSync(path, "utf8").trim();
}

// ----------------------------------------------------------------- sending ---

/**
 * Simulate first (refusing a failure, an unknown top-level program or an
 * oversized transaction), then add `signers`' signatures and send. Signers
 * are added with `partialSign`, so signatures already on the transaction
 * (e.g. the fresh mint keypair of `buildLaunchTx`) are kept. With
 * `finalized`, it waits until the transaction is finalized (`sendAndConfirm`
 * preflights at "confirmed", where the builders' blockhash is known, and
 * waits at the commitment asked for).
 */
export async function simulateSignSend(conn: Connection, tx: Transaction, signers: readonly Keypair[], what: string, opts: { finalized?: boolean } = {}): Promise<string> {
  const sim = await simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`${what}: simulation failed: ${sim.error ?? "unknown error"}\n${sim.logs.slice(-8).join("\n")}`);
  if (sim.unknownPrograms.length > 0) throw new Error(`${what}: refusing to sign a transaction that calls unknown programs: ${sim.unknownPrograms.map((p) => p.toBase58()).join(", ")}`);
  if (sim.sizeBytes > sim.sizeLimit) throw new Error(`${what}: ${sim.sizeBytes} bytes, over the ${sim.sizeLimit}-byte limit`);
  tx.partialSign(...signers);
  const signature = await sendAndConfirm(conn, tx, { commitment: opts.finalized === true ? "finalized" : "confirmed" });
  console.log(`${what}: ${signature}${opts.finalized === true ? " (finalized)" : ""}`);
  return signature;
}

/** Simulate signed v1 wire bytes (refusing a failure or an unknown program), then send them as they are. */
export async function simulateSendV1(conn: Connection, tx: Uint8Array, lastValidBlockHeight: number, what: string): Promise<string> {
  const sim = await simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`${what}: simulation failed: ${sim.error ?? "unknown error"}\n${sim.logs.slice(-8).join("\n")}`);
  if (sim.unknownPrograms.length > 0) throw new Error(`${what}: refusing to send a transaction that calls unknown programs`);
  const signature = await sendAndConfirm(conn, tx, { lastValidBlockHeight });
  console.log(`${what}: ${signature}`);
  return signature;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------ durable files ---

/** Write `data` to `path` and fsync it (`flag` "wx" = create only if absent: atomic exclusive create). */
function writeDurably(path: string, data: string | Uint8Array, flag: "w" | "wx"): void {
  const fd = openSync(path, flag);
  try {
    if (typeof data === "string") writeSync(fd, data);
    else writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replace `path` atomically: write a temporary file, fsync it, rename it over. */
export function replaceDurably(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeDurably(tmp, data, "w");
  renameSync(tmp, path);
}

const errorCode = (e: unknown): unknown => (typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined);

/**
 * A `LeafLedgerStore` on a directory, one file per key, for the leaf ledger
 * and the vault-key ledger alike. `add` is an exclusive create
 * (`O_CREAT | O_EXCL`), which is atomic even across processes: that is the
 * one property a ledger needs to guarantee one message per one-time key. A crash between create and write leaves an empty file,
 * which the ledger treats as taken (never as free). Keep the directory on a
 * disk that is backed up, and never share it between two identities' owners.
 */
export function fileLeafLedgerStore(dir: string): LeafLedgerStore {
  mkdirSync(dir, { recursive: true });
  const file = (key: string): string => join(dir, encodeURIComponent(key));
  return {
    async get(key) {
      try {
        return readFileSync(file(key), "utf8");
      } catch (e) {
        if (errorCode(e) === "ENOENT") return null;
        throw e;
      }
    },
    async add(key, value) {
      try {
        writeDurably(file(key), value, "wx");
        return true;
      } catch (e) {
        if (errorCode(e) === "EEXIST") return false;
        throw e;
      }
    },
    async put(key, value) {
      replaceDurably(file(key), value);
    },
    async keys(prefix) {
      return readdirSync(dir)
        .filter((name) => !name.endsWith(".tmp"))
        .map((name) => decodeURIComponent(name))
        .filter((key) => key.startsWith(prefix));
    },
  };
}

/**
 * An LMS tree cache on a directory (`lms.LmsTreeCacheStore`): a cached
 * identity loads in milliseconds instead of a full key generation. The cache
 * is authenticated with a key derived from the identity's secret, so a
 * tampered file is refused and regenerated, never trusted.
 */
export function fileTreeCacheStore(dir: string): lms.LmsTreeCacheStore {
  mkdirSync(dir, { recursive: true });
  const file = (key: string): string => join(dir, encodeURIComponent(key));
  return {
    async get(key) {
      try {
        return new Uint8Array(readFileSync(file(key)));
      } catch (e) {
        if (errorCode(e) === "ENOENT") return null;
        throw e;
      }
    },
    async put(key, value) {
      replaceDurably(file(key), value);
    },
  };
}

// --------------------------------------------------------------- encoding ---

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error("not lower-case hex");
  return new Uint8Array(Buffer.from(s, "hex"));
}

/** Format base units with `decimals` (e.g. lamports with 9). */
export function formatUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

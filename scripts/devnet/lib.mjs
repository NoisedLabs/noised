/**
 * Shared helpers for the Noised DEVNET scripts (scripts/devnet/*.mjs).
 *
 * Environment (no secret is ever read from the environment, only paths):
 *   RPC_URL                  default https://api.devnet.solana.com (a Surfpool
 *                            fork of devnet at http://127.0.0.1:8899 works too:
 *                            it reports devnet's genesis hash; set
 *                            NOISED_REHEARSAL=1 so the results say "fork")
 *   NOISED_DEVNET_DIR        REQUIRED. This run's state directory, OUTSIDE the
 *                            repository: secrets/ (the devnet test PQ phrase and
 *                            throwaway wallets, created on first use, never
 *                            printed), leaf-ledger/, tree-cache/, state-*.json,
 *                            results.jsonl, ledger.md.
 *   NOISED_DEVNET_DEPLOYER   path of the devnet deployer keypair (funds the test
 *                            wallets; signs initialize_protocol as the
 *                            launchpad's upgrade authority).
 *   NOISED_RESERVE_SOL       the deployer never goes below this (default 0.3).
 *   CU_PRICE_MICROLAMPORTS   optional priority fee.
 *   NOISED_SDK_DIR           default <repo>/sdk (its built dist/ is used).
 *
 * The PHALANX_* names of these variables (before the rename to Noised) are
 * still read for one release when the NOISED_* one is unset.
 *
 * Devnet only: every script refuses an RPC whose genesis hash is not devnet's.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");
const SDK_DIR = resolve(env("NOISED_SDK_DIR") || join(REPO, "sdk"));
const sdkRequire = createRequire(join(SDK_DIR, "package.json"));

/** @solana/web3.js exactly as the SDK loads it (one module instance: `instanceof` checks hold). */
export const web3 = sdkRequire("@solana/web3.js");
/** The built SDK (sdk/dist). */
export const sdk = await import(pathToFileURL(join(SDK_DIR, "dist", "index.js")).href);
/** SDK internals the public index does not export (IDL instruction assembly, v1 transactions). */
export const sdkIx = await import(pathToFileURL(join(SDK_DIR, "dist", "codec", "ix.js")).href);
export const sdkV1 = await import(pathToFileURL(join(SDK_DIR, "dist", "tx", "v1.js")).href);
const { encodeBase58 } = await import(pathToFileURL(join(SDK_DIR, "dist", "codec", "base58.js")).href);
export const splToken = await import(pathToFileURL(join(SDK_DIR, "node_modules", "@solana", "spl-token", "lib", "esm", "index.js")).href);
export const SDK_VERSION = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8")).version;

const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = web3;

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const LAMPORTS_PER_SOL = 1_000_000_000n;

// ------------------------------------------------------------------ config ---

/**
 * An environment variable, trimmed (`fallback` when unset or blank). For a
 * NOISED_* name, the PHALANX_* name of earlier releases is read when the new
 * one is unset (one release).
 */
export function env(name, fallback = "") {
  const names = name.startsWith("NOISED_") ? [name, `PHALANX_${name.slice("NOISED_".length)}`] : [name];
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return fallback;
}

export function requireEnv(name) {
  const v = env(name);
  if (v === "") throw new Error(`set ${name} (see the header of scripts/devnet/lib.mjs)`);
  return v;
}

/** Configuration and connection for a run; refuses anything but devnet (or a fork reporting devnet's genesis). */
export async function openRun(flow) {
  const dir = resolve(requireEnv("NOISED_DEVNET_DIR"));
  if ((dir + sep).toLowerCase().startsWith((REPO + sep).toLowerCase())) {
    throw new Error(`NOISED_DEVNET_DIR (${dir}) is inside the repository: secrets and state must live outside it`);
  }
  mkdirSync(join(dir, "secrets"), { recursive: true });
  const rpcUrl = env("RPC_URL", "https://api.devnet.solana.com");
  const conn = new Connection(rpcUrl, { commitment: "confirmed", confirmTransactionInitialTimeout: 120_000 });
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`refusing: ${rpcUrl} has genesis ${genesis}, not devnet's ${DEVNET_GENESIS}`);
  const rehearsal = env("NOISED_REHEARSAL") === "1";
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl);
  if (local && !rehearsal) throw new Error("a local RPC must be a rehearsal: set NOISED_REHEARSAL=1");
  {
    // The public devnet RPC rate-limits by connection ("429 ... Connection rate limits exceeded"); web3.js gives
    // up after ~8 s of retries and throws, sometimes from a request nobody awaits (which kills the process).
    // A rate-limited request was not processed, so wait longer and retry it.
    // Rehearsal: Surfpool fetches unknown accounts from devnet while it processes a request, and the public
    // devnet RPC sometimes drops those fetches ("Failed to fetch accounts from remote"): also not processed.
    const inner = conn._rpcRequest.bind(conn);
    conn._rpcRequest = async (method, args) => {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await inner(method, args);
        } catch (e) {
          if (attempt >= 8 || !/429|rate limit/i.test(String(e?.message ?? e))) throw e;
          await sleep(5000 + attempt * 2500);
          continue;
        }
        const m = res?.error?.message ?? "";
        const retry = /rate limit|Too Many Requests/i.test(m) || (rehearsal && /fetch accounts from remote|error sending request/.test(m));
        if (attempt >= 8 || !retry) return res;
        await sleep(3000 + attempt * 2000);
      }
    };
  }
  const cuPriceText = env("CU_PRICE_MICROLAMPORTS");
  const ctx = {
    flow,
    dir,
    conn,
    rpcUrl,
    rehearsal,
    reserveLamports: BigInt(Math.round(Number(env("NOISED_RESERVE_SOL", "0.3")) * 1e9)),
    computeUnitPrice: cuPriceText === "" ? undefined : BigInt(cuPriceText),
    deployerPath: env("NOISED_DEVNET_DEPLOYER"),
    statePath: join(dir, `state-${flow}.json`),
    state: {},
  };
  if (existsSync(ctx.statePath)) ctx.state = JSON.parse(readFileSync(ctx.statePath, "utf8"));
  log(ctx, `== ${flow} on ${rehearsal ? "a Surfpool fork of devnet" : "devnet"} (${rpcUrl}), SDK ${SDK_VERSION}, state ${dir}`);
  return ctx;
}

export function saveState(ctx) {
  replaceDurably(ctx.statePath, JSON.stringify(ctx.state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

// ------------------------------------------------------------------- files ---

function writeDurably(path, data, flag) {
  const fd = openSync(path, flag, 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function replaceDurably(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeDurably(tmp, data, "w");
  renameSync(tmp, path);
}

/** One file per key; `add` is an exclusive create (the leaf ledger's one-signature-per-leaf guarantee). */
export function fileLeafLedgerStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = (key) => join(dir, encodeURIComponent(key));
  return {
    async get(key) {
      try {
        return readFileSync(file(key), "utf8");
      } catch (e) {
        if (e?.code === "ENOENT") return null;
        throw e;
      }
    },
    async add(key, value) {
      try {
        writeDurably(file(key), value, "wx");
        return true;
      } catch (e) {
        if (e?.code === "EEXIST") return false;
        throw e;
      }
    },
    async put(key, value) {
      replaceDurably(file(key), value);
    },
    async keys(prefix) {
      return readdirSync(dir)
        .filter((n) => !n.endsWith(".tmp"))
        .map((n) => decodeURIComponent(n))
        .filter((k) => k.startsWith(prefix));
    },
  };
}

export function fileTreeCacheStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = (key) => join(dir, encodeURIComponent(key));
  return {
    async get(key) {
      try {
        return new Uint8Array(readFileSync(file(key)));
      } catch (e) {
        if (e?.code === "ENOENT") return null;
        throw e;
      }
    },
    async put(key, value) {
      replaceDurably(file(key), value);
    },
  };
}

// ----------------------------------------------------------------- secrets ---

export function loadKeypairFile(path) {
  const bytes = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${path} is not a Solana CLI keypair file`);
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/** A throwaway devnet wallet kept in secrets/<name>.json (created on first use; never printed). */
export function testWallet(ctx, name) {
  const path = join(ctx.dir, "secrets", `${name}.json`);
  if (!existsSync(path)) writeDurably(path, JSON.stringify(Array.from(Keypair.generate().secretKey)), "wx");
  return loadKeypairFile(path);
}

export function deployer(ctx) {
  if (ctx.deployerPath === "") throw new Error("set NOISED_DEVNET_DEPLOYER");
  return loadKeypairFile(ctx.deployerPath);
}

/**
 * A devnet TEST phrase (24 words) in secrets/<name>.txt, generated on first
 * use: "pq-phrase" (the creator identity) or "treasury-phrase" (the
 * protocol treasury vault). Never printed, never in the repo.
 */
export function testMaster(ctx, name = "pq-phrase") {
  const path = join(ctx.dir, "secrets", `${name}.txt`);
  if (!existsSync(path)) writeDurably(path, sdk.generateRecoveryPhrase(), "wx");
  return sdk.pqIdentity.importMaster(readFileSync(path, "utf8").trim());
}

/** The creator identity (index `index` of the test phrase, derived for devnet) and its durable leaf ledger. */
export async function testIdentity(ctx, master, index = 0) {
  const identity = await sdk.pqIdentity.deriveIdentity(master.master, "devnet", index, { cache: fileTreeCacheStore(join(ctx.dir, "tree-cache")) });
  const ledger = sdk.leafLedger.createLeafLedger(fileLeafLedgerStore(join(ctx.dir, "leaf-ledger")));
  return { identity, ledger };
}

// ------------------------------------------------------------------ output ---

export function log(ctx, line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  appendFileSync(join(ctx.dir, `console-${ctx.flow}.log`), text + "\n");
}

export function explorer(ctx, sig) {
  const base = `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  return ctx.rehearsal ? `${base} (fork only: not on devnet)` : base;
}

function record(ctx, entry) {
  const row = { at: new Date().toISOString(), flow: ctx.flow, rehearsal: ctx.rehearsal, ...entry };
  appendFileSync(join(ctx.dir, "results.jsonl"), JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}

/** Record a note (no transaction, not a check), e.g. where a budget stop happened. */
export function note(ctx, step, detail) {
  log(ctx, `NOTE ${step}: ${detail}`);
  record(ctx, { step, kind: "note", detail });
}

/** Record a check (no transaction): `ok` true/false with a detail line. */
export function check(ctx, step, ok, detail) {
  log(ctx, `${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
  record(ctx, { step, kind: "check", ok, detail });
  if (!ok) ctx.failures = (ctx.failures ?? 0) + 1;
  return ok;
}

/** The landed transaction's meta (compute units, fee, logs, error), any version. */
export async function txDetails(ctx, signature) {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const maxSupportedTransactionVersion of [1, 0]) {
      const res = await rpc(ctx, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion }]);
      if (res.error !== undefined) continue;
      if (res.result !== null && res.result !== undefined) {
        const m = res.result.meta ?? {};
        return { slot: res.result.slot, cu: m.computeUnitsConsumed ?? null, fee: m.fee ?? null, err: m.err ?? null, logs: m.logMessages ?? [], version: res.result.version ?? null };
      }
    }
    await sleep(1500);
  }
  return null;
}

export async function rpc(ctx, method, params) {
  const r = await fetch(ctx.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}

/** Record a landed transaction (signature from an SDK send), with its compute units and fee. */
export async function landed(ctx, step, signature, note = "") {
  const d = await txDetails(ctx, signature);
  const ok = d !== null && d.err === null;
  log(ctx, `${ok ? "OK  " : "ERR "} ${step}: ${signature} cu=${d?.cu ?? "?"} fee=${d?.fee ?? "?"}${note ? ` (${note})` : ""}\n      ${explorer(ctx, signature)}`);
  record(ctx, { step, kind: "tx", ok, signature, explorer: explorer(ctx, signature), cu: d?.cu ?? null, fee: d?.fee ?? null, version: d?.version ?? null, err: d?.err ?? null, note, logsTail: ok ? undefined : d?.logs.slice(-12) });
  if (!ok) throw new Error(`${step}: transaction ${signature} failed: ${JSON.stringify(d?.err)}`);
  return d;
}

/**
 * Simulate (refusing failures), sign with `signers` and send a legacy
 * transaction, then record it. `expectError`: a negative test. The
 * transaction is sent WITHOUT preflight so the refusal lands on-chain (it
 * costs the signature fee), and must fail with a message or log containing
 * `expectError`.
 */
export async function send(ctx, step, tx, signers, opts = {}) {
  const sim = await sdk.simulateAndExplain(ctx.conn, tx);
  if (opts.expectError !== undefined) {
    const text = `${sim.error ?? ""}\n${(sim.logs ?? []).join("\n")}`;
    const matches = (t) => (opts.expectError instanceof RegExp ? opts.expectError.test(t) : t.includes(opts.expectError));
    const simRefused = !sim.ok && matches(text);
    tx.partialSign(...signers);
    // The fee payer's signature is the transaction id: known before sending, so the landed failure can be
    // looked up even when the send or the confirmation throws (a refused transaction always throws there).
    const signature = encodeBase58(tx.signature);
    let sendError = null;
    try {
      await sdk.sendAndConfirm(ctx.conn, tx, { skipPreflight: true });
    } catch (e) {
      // web3.js can reject with a plain object (no message): print it as JSON.
      sendError = e instanceof Error ? e.message : typeof e === "object" && e !== null ? json(e) : String(e);
    }
    if (sendError !== null && !sendError.includes(`transaction ${signature} failed`)) log(ctx, `note: sending ${step} threw: ${sendError.split("\n")[0]}`);
    let d = await txDetails(ctx, signature);
    // A skip-preflight send can take a few slots to show up in getTransaction on a public RPC.
    for (let i = 0; d === null && i < 6; i++) {
      await sleep(5000);
      d = await txDetails(ctx, signature);
    }
    const landedText = d === null ? "" : `${JSON.stringify(d.err)}\n${d.logs.join("\n")}`;
    const ok = simRefused && d !== null && d.err !== null && matches(landedText);
    log(ctx, `${ok ? "PASS" : "FAIL"} ${step} (expected failure "${opts.expectError}"): simulation ${sim.ok ? "passed" : `refused (${sim.error})`}; on-chain ${d === null ? `not found (${signature})` : d.err === null ? "SUCCEEDED (unexpected)" : `failed as expected (${JSON.stringify(d.err)}, cu ${d.cu}, fee ${d.fee})`}\n      ${explorer(ctx, signature)}`);
    record(ctx, { step, kind: "negative-tx", ok, expectError: String(opts.expectError), signature, explorer: d === null ? null : explorer(ctx, signature), landed: d !== null, err: d?.err ?? null, cu: d?.cu ?? null, fee: d?.fee ?? null, simError: sim.error, sendError, logsTail: (d?.logs ?? sim.logs ?? []).slice(-10) });
    if (!ok) ctx.failures = (ctx.failures ?? 0) + 1;
    return { ok, signature, details: d, sim };
  }
  if (!sim.ok) {
    log(ctx, `FAIL ${step}: simulation failed: ${sim.error}\n${(sim.logs ?? []).slice(-14).join("\n")}`);
    record(ctx, { step, kind: "tx", ok: false, simError: sim.error, logsTail: (sim.logs ?? []).slice(-14) });
    throw new Error(`${step}: simulation failed: ${sim.error}`);
  }
  if (sim.sizeBytes > sim.sizeLimit) throw new Error(`${step}: ${sim.sizeBytes} bytes, over the ${sim.sizeLimit}-byte limit`);
  if (tx instanceof Transaction) tx.partialSign(...signers);
  const signature = await sdk.sendAndConfirm(ctx.conn, tx, { commitment: opts.finalized ? "finalized" : "confirmed" });
  const d = await landed(ctx, step, signature, `${sim.format} ${sim.sizeBytes} B${opts.note ? `; ${opts.note}` : ""}`);
  return { signature, details: d, sim };
}

/** Build a v1 transaction (SIMD-0385) from instructions, sign, simulate, send and record it. */
export async function sendV1(ctx, step, payer, ixs, extraSigners = [], cfg = {}) {
  const { blockhash, lastValidBlockHeight } = await ctx.conn.getLatestBlockhash("confirmed");
  const message = sdkV1.compileV1Message(payer.publicKey, ixs, blockhash, {
    computeUnitLimit: cfg.computeUnitLimit ?? 1_400_000,
    loadedAccountsDataSizeLimit: cfg.loadedAccountsDataSizeLimit ?? 8 * 1024 * 1024,
    ...(ctx.computeUnitPrice ? { priorityFeeLamports: sdk.priorityFeeLamports(ctx.computeUnitPrice, cfg.computeUnitLimit ?? 1_400_000) } : {}),
  });
  const bytes = sdkV1.signV1Message(message, [payer, ...extraSigners]);
  const sim = await sdk.simulateAndExplain(ctx.conn, bytes);
  if (!sim.ok) {
    log(ctx, `FAIL ${step}: simulation failed: ${sim.error}\n${(sim.logs ?? []).slice(-14).join("\n")}`);
    record(ctx, { step, kind: "tx", ok: false, simError: sim.error, logsTail: (sim.logs ?? []).slice(-14) });
    throw new Error(`${step}: simulation failed: ${sim.error}`);
  }
  const signature = await sdk.sendAndConfirm(ctx.conn, bytes, { lastValidBlockHeight });
  const d = await landed(ctx, step, signature, `v1 ${bytes.length} B`);
  return { signature, details: d };
}

// ---------------------------------------------------------------- balances ---

export async function lamports(ctx, pk) {
  return BigInt(await ctx.conn.getBalance(pk, "confirmed"));
}

export const sol = (l) => (Number(l) / 1e9).toFixed(9);

/**
 * Append the balances of `wallets` ({ name: PublicKey }) to ledger.md, with
 * the change since the previous row of this run.
 */
export async function ledgerRow(ctx, step, wallets) {
  const path = join(ctx.dir, "ledger.md");
  if (!existsSync(path)) {
    writeFileSync(path, `# SOL ledger of ${ctx.dir}\n\n| When | Flow | Step | Balances (SOL) | Change since previous row |\n|---|---|---|---|---|\n`);
  }
  const now = {};
  for (const [name, pk] of Object.entries(wallets)) now[name] = await lamports(ctx, pk);
  const prev = ctx.lastBalances ?? ctx.state.lastBalances ?? null;
  const fmt = Object.entries(now).map(([n, l]) => `${n} ${sol(l)}`).join("; ");
  const delta = prev === null ? "" : Object.entries(now).map(([n, l]) => `${n} ${sol(l - BigInt(prev[n] ?? l))}`).join("; ");
  appendFileSync(path, `| ${new Date().toISOString()} | ${ctx.flow} | ${step} | ${fmt} | ${delta} |\n`);
  ctx.lastBalances = Object.fromEntries(Object.entries(now).map(([n, l]) => [n, l.toString()]));
  ctx.state.lastBalances = ctx.lastBalances;
  saveState(ctx);
  return now;
}

/** Move `amount` lamports from the deployer to `to`, refusing to cross the reserve. */
export async function fundFromDeployer(ctx, step, to, amount) {
  const d = deployer(ctx);
  const bal = await lamports(ctx, d.publicKey);
  if (bal - amount - 10_000n < ctx.reserveLamports) {
    throw new Error(`RESERVE: funding ${sol(amount)} SOL would leave the deployer ${sol(bal - amount)} SOL, below the ${sol(ctx.reserveLamports)} SOL reserve: stop and report`);
  }
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: d.publicKey, toPubkey: to, lamports: amount }));
  tx.feePayer = d.publicKey;
  const { blockhash, lastValidBlockHeight } = await ctx.conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return send(ctx, step, tx, [d]);
}

/** Top `wallet` up to `target` lamports from the deployer (nothing when it already holds that much). */
export async function topUp(ctx, step, wallet, target) {
  const have = await lamports(ctx, wallet);
  if (have >= target) return null;
  return fundFromDeployer(ctx, step, wallet, target - have);
}

/** Send everything `kp` holds (minus the fee) back to `to`. */
export async function sweep(ctx, step, kp, to) {
  const bal = await lamports(ctx, kp.publicKey);
  if (bal <= 5_000n) return null;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: bal - 5_000n }));
  tx.feePayer = kp.publicKey;
  const { blockhash, lastValidBlockHeight } = await ctx.conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return send(ctx, step, tx, [kp]);
}

// -------------------------------------------------------------------- time ---

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the CLUSTER clock reaches `ts` (bigint unix seconds). */
export async function waitForClusterTime(ctx, ts, what) {
  for (;;) {
    const now = await sdk.clusterUnixTime(ctx.conn);
    if (now >= ts) return now;
    const left = ts - now;
    log(ctx, `waiting ${left} s (cluster clock) for ${what}`);
    await sleep(Number(left > 20n ? 20n : left) * 1000 + 500);
  }
}

/** Finish a legacy transaction for `payer` (blockhash, fee payer). */
export async function legacyTx(ctx, payer, ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  const { blockhash, lastValidBlockHeight } = await ctx.conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/** A 32x32, 4-colour test icon (a shield-like diagonal), as an indexed PNG. */
export async function testIcon(seed = 0) {
  const w = 32;
  const rgba = new Uint8Array(w * w * 4);
  const colours = [
    [12, 22, 40, 255],
    [88, 196, 255, 255],
    [230, 244, 255, 255],
    [40 + seed * 50, 90, 160, 255],
  ];
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const inShield = Math.abs(x - 15.5) < 12 - Math.max(0, y - 18) * 0.9 && y > 3 && y < 30;
      const c = !inShield ? 0 : (x + y) % 9 < 3 ? 2 : y < 12 ? 3 : 1;
      rgba.set(colours[c], (y * w + x) * 4);
    }
  }
  return sdk.encodeIndexedPng(rgba, w, w, 4, { compression: "store" });
}

export const toHex = (b) => Buffer.from(b).toString("hex");
export const fromHex = (s) => new Uint8Array(Buffer.from(s, "hex"));
export const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof PublicKey ? x.toBase58() : x));

/** Run `main(ctx)` and report; exit code 1 on an error or a failed check. */
export async function runMain(flow, main) {
  let ctx = null;
  try {
    ctx = await openRun(flow);
    await main(ctx);
    if ((ctx.failures ?? 0) > 0) {
      log(ctx, `${flow}: finished with ${ctx.failures} failed check(s)`);
      process.exitCode = 1;
    } else log(ctx, `${flow}: finished`);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
    if (ctx !== null) log(ctx, `${flow}: STOPPED: ${msg}`);
    else console.error(msg);
    process.exitCode = 1;
  }
}

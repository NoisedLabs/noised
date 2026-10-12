/**
 * Read-only DEVNET pre-flight (spends nothing):
 * - the RPC is devnet (genesis hash);
 * - Meteora DBC and DAMM v2, Token-2022, SPL Token, ATA and Memo exist and are executable;
 * - the six DAMM v2 migration configs and the customizable one the SDK pins
 *   (DAMM_V2_MIGRATION_CONFIGS) and the wSOL mint exist with the expected
 *   owner and size, byte-identical to the mainnet fixtures when
 *   NOISED_FIXTURES_DIR is set;
 * - DBC's pool authority holds a float (DBC lends migration rent from it);
 * - the runtime features the programs need are active (SBPF v3 deployment,
 *   SIMD-0385 v1 transactions);
 * - each Noised program: deployed or not, its upgrade authority and data
 *   length, and (with NOISED_SBF_DIR) whether the on-chain bytes equal the
 *   local build. The programs on devnet run builds made before the rename to
 *   Noised (phalanx_<program>.so, see docs/DEVNET.md): a phalanx_<program>.so
 *   in NOISED_SBF_DIR is compared when there is no noised_<program>.so;
 * - whether the launchpad's Protocol is initialized.
 *
 *   NOISED_DEVNET_DIR=<state dir> [NOISED_SBF_DIR=<dir with noised_*.so or phalanx_*.so>] [NOISED_FIXTURES_DIR=<mainnet fixtures>] \
 *   node scripts/devnet/00-preflight.mjs
 *
 * The PHALANX_* names of these variables are still read (see lib.mjs).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { check, env, log, runMain, sdk, web3 } from "./lib.mjs";

const { PublicKey } = web3;
const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const FEATURES = {
  "SIMD-0385 transaction v1": "txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL",
  "SBPF v3 deployment and execution": "5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC",
};
const CUSTOMIZABLE_DAMM_CONFIG = "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck";

await runMain("preflight", async (ctx) => {
  const { conn } = ctx;
  const K = sdk.KNOWN_ACCOUNTS;
  const P = sdk.PROGRAM_IDS;
  for (const [name, id] of Object.entries({ "Meteora DBC": P.dbc, "Meteora DAMM v2": P.dammV2, "Token-2022": K.token2022, "SPL Token": K.splToken, ATA: K.associatedToken, "Memo v2": K.memo })) {
    const acc = await conn.getAccountInfo(id, "confirmed");
    const pd = acc !== null && acc.owner.equals(LOADER_V3) ? await programData(conn, id) : null;
    check(ctx, `${name} exists`, acc !== null && acc.executable, `${id.toBase58()}: owner ${acc?.owner.toBase58()}${pd ? `, data ${pd.len} bytes, last deployed slot ${pd.slot}, authority ${pd.authority ?? "none"}` : ""}`);
  }
  const fixtures = env("NOISED_FIXTURES_DIR");
  const configs = [...sdk.DAMM_V2_MIGRATION_CONFIGS.map((c) => c.toBase58()), CUSTOMIZABLE_DAMM_CONFIG];
  for (const [i, addr] of configs.entries()) {
    const acc = await conn.getAccountInfo(new PublicKey(addr), "confirmed");
    let same = "";
    if (acc !== null && fixtures && existsSync(join(fixtures, "accounts", `${addr}.json`))) {
      const f = JSON.parse(readFileSync(join(fixtures, "accounts", `${addr}.json`), "utf8"));
      same = Buffer.from(f.account.data[0], "base64").equals(acc.data) ? ", byte-identical to the mainnet fixture" : ", DIFFERS from the mainnet fixture";
    }
    check(ctx, `DAMM v2 config ${i < 6 ? `fee option ${i}` : "customizable"}`, acc !== null && acc.owner.equals(P.dammV2) && acc.data.length === 328 && !same.includes("DIFFERS"), `${addr}: owner ${acc?.owner.toBase58()}, ${acc?.data.length} bytes${same}`);
  }
  const wsol = await conn.getAccountInfo(sdk.WSOL_MINT, "confirmed");
  check(ctx, "wSOL mint", wsol !== null && wsol.owner.equals(K.splToken) && wsol.data.length === 82, `owner ${wsol?.owner.toBase58()}`);
  const float = await conn.getBalance(K.dbcPoolAuthority, "confirmed");
  check(ctx, "DBC pool authority float (migration flash rent)", float > 1e9, `${K.dbcPoolAuthority.toBase58()} holds ${(float / 1e9).toFixed(3)} SOL`);
  for (const [name, id] of Object.entries(FEATURES)) {
    const acc = await conn.getAccountInfo(new PublicKey(id), "confirmed");
    // Feature account: Option<u64> activated_at (tag byte 1 = active).
    check(ctx, `feature ${name}`, acc !== null && acc.data[0] === 1, `${id}: ${acc === null ? "absent" : acc.data[0] === 1 ? `active since slot ${acc.data.readBigUInt64LE(1)}` : "pending"}`);
  }
  const sbfDir = env("NOISED_SBF_DIR");
  for (const [name, id] of Object.entries({ noised_hook: P.hook, noised_launchpad: P.launchpad, noised_autopilot: P.autopilot, noised_vault: P.vault, noised_shield: P.shield })) {
    const pd = await programData(conn, id);
    if (pd === null) {
      log(ctx, `INFO ${name} ${id.toBase58()}: not deployed`);
      continue;
    }
    let match = "";
    // A build made before the rename (phalanx_<program>.so) when the directory has no noised_<program>.so.
    const soFile = sbfDir ? [`${name}.so`, `${name.replace(/^noised_/, "phalanx_")}.so`].map((f) => join(sbfDir, f)).find((p) => existsSync(p)) : undefined;
    if (soFile !== undefined) {
      const local = readFileSync(soFile);
      const onchain = pd.bytes.subarray(0, local.length);
      const padOk = pd.bytes.subarray(local.length).every((b) => b === 0);
      match = `; on-chain sha256 ${createHash("sha256").update(pd.bytes).digest("hex")}, ${onchain.equals(local) && padOk ? "EQUALS" : "DIFFERS FROM"} the local build ${basename(soFile)} (sha256 ${createHash("sha256").update(local).digest("hex")})`;
    }
    check(ctx, `${name} deployed`, !match.includes("DIFFERS"), `${id.toBase58()}: ${pd.len} bytes, authority ${pd.authority ?? "none (final)"}, slot ${pd.slot}${match}`);
  }
  const protocol = await sdk.fetchProtocol(conn);
  log(ctx, `INFO Protocol ${sdk.protocolAddress().toBase58()}: ${protocol === null ? "not initialized" : `treasury ${protocol.treasury.toBase58()}, platform_fee_bps ${protocol.platformFeeBps}`}`);
});

/** ProgramData of an upgradeable program: u32 tag, u64 slot, Option<Pubkey> authority, then the program bytes (from byte 45). */
async function programData(conn, program) {
  const acc = await conn.getAccountInfo(program, "confirmed");
  if (acc === null || !acc.owner.equals(LOADER_V3)) return null;
  const address = new PublicKey(acc.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(address, "confirmed");
  if (pd === null) return null;
  return {
    address,
    slot: pd.data.readBigUInt64LE(4),
    authority: pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null,
    len: pd.data.length - 45,
    bytes: pd.data.subarray(45),
  };
}

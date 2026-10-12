/**
 * A coherent mocked Noised launch, account by account: mint bytes as
 * Token-2022 writes them, certificate / launch / policy as the programs write
 * them, DBC accounts decoded from zero bytes and filled through the vendored
 * IDL, loader-v3 program accounts. Shared by the verifier and builder tests.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { concatBytes, u32le, u64le } from "../src/codec/bytes.js";
import { CERTIFICATE_ALL_CHECKS, KNOWN_ACCOUNTS, PROGRAM_IDS, TRUST_ANCHORS, WSOL_MINT } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { certificateAddress, dbcPoolAddress, dbcTokenVaultAddress, extraAccountMetaListAddress, hookPolicyAddress, launchPdas, programDataAddress, protocolAddress } from "../src/pda.js";
import { ext, key, MockConnection, mintBytes, T22, upgradeableProgram, type TlvSpec } from "./helpers.js";

export const NOW = 1_800_000_000;
export const SUPPLY = 1_000_000_000_000_000n;
export const THRESHOLD = 85_000_000_000n;

export interface World {
  conn: MockConnection;
  mint: PublicKey;
  launch: PublicKey;
  launchAuthority: PublicKey;
  batchAuthority: PublicKey;
  dbcConfig: PublicKey;
  pool: PublicKey;
  // mutable inputs, applied by build()
  mintOpts: { mintAuthority: PublicKey | null; freezeAuthority: PublicKey | null; supply: bigint; decimals: number; extensions: TlvSpec[]; owner: PublicKey };
  cert: Record<string, unknown>;
  launchState: Record<string, unknown>;
  config: Record<string, unknown> & { config: Record<string, unknown> };
  poolState: Record<string, unknown>;
  policy: Record<string, unknown>;
  build(): void;
}

export const codec = idlCodecs();

export function accountBytes(idl: keyof ReturnType<typeof idlCodecs>, name: string, value: unknown): Uint8Array {
  return concatBytes([codec[idl].accountDiscriminator(name), codec[idl].encodeType(name, withAutopilotDefaults(idl, name, value))]);
}

/**
 * The fields audit round 4 appended to `Autopilot` (`active_auth`, `active_activate_at`, `partial_spent`), defaulted
 * when a test does not set them: no activation recorded, no partial buyback open.
 */
function withAutopilotDefaults(idl: string, name: string, value: unknown): unknown {
  if (idl !== "autopilot" || name !== "Autopilot" || value === null || typeof value !== "object") return value;
  return { activeAuth: PublicKey.default, activeActivateAt: 0n, partialSpent: Array.from({ length: 16 }, () => 0n), ...(value as Record<string, unknown>) };
}

/** A Meteora zero-copy account decoded from all-zero bytes: every field present, all zero. */
export function zeroed(idl: "dbc" | "dammV2", name: string): Record<string, unknown> {
  const size = codec[idl].accountSize(name);
  return codec[idl].decodeAccount<Record<string, unknown>>(name, concatBytes([codec[idl].accountDiscriminator(name), new Uint8Array(size - 8)]));
}

/**
 * The meta list Launch Guard writes, encoded here by hand from the TLV
 * layout: the policy PDA `["policy", <account 1 = mint>]`, then the
 * instructions sysvar by address (tests/integration `expected_meta_list_data`).
 */
export function metaListBytes(): Uint8Array {
  const disc = sha256(new TextEncoder().encode("spl-transfer-hook-interface:execute")).slice(0, 8);
  const config = new Uint8Array(32);
  config.set([1, 6, ...new TextEncoder().encode("policy"), 3, 1]);
  const policy = concatBytes([Uint8Array.of(1), config, Uint8Array.of(0, 0)]);
  const sysvar = concatBytes([Uint8Array.of(0), KNOWN_ACCOUNTS.sysvarInstructions.toBytes(), Uint8Array.of(0, 0)]);
  return concatBytes([disc, u32le(74), u32le(2), policy, sysvar]);
}

export function clock(unix: number): Uint8Array {
  return concatBytes([u64le(400_000_000n), u64le(0n), u64le(900n), u64le(901n), u64le(BigInt(unix))]);
}

export function world(): World {
  const conn = new MockConnection();
  const mint = key("verify/mint");
  const creator = key("verify/creator");
  const treasury = key("verify/treasury");
  const seed = sha256(new TextEncoder().encode("verify/seed"));
  const pqIdentity = sha256(new TextEncoder().encode("verify/pq-identity"));
  const p = launchPdas(creator, seed);
  const pool = dbcPoolAddress(p.dbcConfig, mint, WSOL_MINT);
  const launchTs = BigInt(NOW - 1_000);
  const openDelay = 300;
  const guard = 6 * 3600;
  const commitEnd = launchTs + BigInt(openDelay);
  const executeEnd = commitEnd + 600n; // EXECUTION_GRACE_SECS
  const guardEnd = launchTs + BigInt(guard);
  const recipients = [
    { wallet: key("verify/r1"), bps: 7_000 },
    { wallet: key("verify/r2"), bps: 3_000 },
    { wallet: PublicKey.default, bps: 0 },
    { wallet: PublicKey.default, bps: 0 },
  ];
  const paramsHash = sha256(new TextEncoder().encode("params"));
  const [, certBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("certificate"), mint.toBytes()], PROGRAM_IDS.launchpad);
  const maxWallet = (SUPPLY * 100n) / 10_000n;
  const maxBuy = (SUPPLY * 50n) / 10_000n;

  const w: World = {
    conn,
    mint,
    launch: p.launch,
    launchAuthority: p.launchAuthority,
    batchAuthority: p.batchAuthority,
    dbcConfig: p.dbcConfig,
    pool,
    mintOpts: {
      mintAuthority: null,
      freezeAuthority: null,
      supply: SUPPLY,
      decimals: 6,
      owner: T22,
      extensions: [
        ext.metadataPointer(null, mint),
        ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook),
        ext.tokenMetadata({ updateAuthority: null, mint, name: "Verified", symbol: "VER", uri: "" }),
      ],
    },
    cert: {
      version: 4,
      bump: certBump,
      launch: p.launch,
      baseMint: mint,
      pool,
      dbcConfig: p.dbcConfig,
      creator,
      launchedAt: launchTs,
      tokenDecimal: 6,
      initialSupply: SUPPLY,
      checks: CERTIFICATE_ALL_CHECKS,
      migrationQuoteThreshold: THRESHOLD,
      migrationFeeOption: 2,
      snipeShieldEndTs: executeEnd,
      executeEndTs: executeEnd,
      guardEndTs: guardEnd,
      maxWallet,
      maxBuy,
      p2pLocked: false,
      platformFeeBps: 1_000,
      recipients,
      paramsHash,
      policyVersion: 3,
      pqIdentity,
      pqLeaf: 511,
      attestedSlot: 399_999_000n,
      // The attested metadata record (`withPq` publishes it and names it here).
      metadata: PublicKey.default,
      // Certificate v4 (P1c): no creator rules.
      rulesHash: new Uint8Array(32),
    },
    launchState: {
      version: 2,
      bump: 255,
      authorityBump: 254,
      batchBump: 253,
      configBump: 252,
      status: { kind: "Live" },
      launchSeed: seed,
      creator,
      dbcConfig: p.dbcConfig,
      launchAuthority: p.launchAuthority,
      batchAuthority: p.batchAuthority,
      baseMint: mint,
      pool,
      treasury,
      platformFeeBps: 1_000,
      recipients,
      recipientCount: 2,
      tokenDecimal: 6,
      migrationQuoteThreshold: THRESHOLD,
      migrationFeeOption: 2,
      openDelaySecs: openDelay,
      guardSecs: guard,
      maxWalletBps: 100,
      maxBuyBps: 50,
      p2pLocked: false,
      batchWalletCap: 5_000_000_000n,
      batchTotalCap: THRESHOLD,
      paramsHash,
      launchTs,
      commitEndTs: commitEnd,
      executeEndTs: executeEnd,
      guardEndTs: guardEnd,
      totalCommitted: 10_000_000_000n,
      executed: true,
      quoteSpent: 9_900_000_000n,
      tokensOut: 50_000_000_000_000n,
      tokensClaimed: 0n,
      quoteRefunded: 0n,
      pqIdentity,
    },
    config: zeroed("dbc", "ConfigWithTransferHook") as World["config"],
    poolState: zeroed("dbc", "TransferHookPool"),
    policy: {
      version: 2,
      bump: 250,
      mint,
      pool,
      baseVault: dbcTokenVaultAddress(mint, pool),
      launchTs,
      snipeShieldEndTs: executeEnd,
      guardEndTs: guardEnd,
      maxWallet,
      maxBuy,
      p2pLocked: false,
      exempt: [p.batchAuthority, p.launchAuthority, PublicKey.default, PublicKey.default],
      // HookPolicy v2 (P1c): the creator rules (none).
      rules: new Uint8Array(0),
    },
    build() {
      conn.set(mint, { owner: w.mintOpts.owner, data: mintBytes(w.mintOpts) });
      conn.set(certificateAddress(mint), { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Certificate", w.cert) });
      conn.set(p.launch, { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Launch", w.launchState) });
      conn.set(p.dbcConfig, { owner: PROGRAM_IDS.dbc, data: accountBytes("dbc", "ConfigWithTransferHook", w.config) });
      conn.set(pool, { owner: PROGRAM_IDS.dbc, data: accountBytes("dbc", "TransferHookPool", w.poolState) });
      conn.set(hookPolicyAddress(mint), { owner: PROGRAM_IDS.hook, data: accountBytes("hook", "HookPolicy", w.policy) });
    },
  };

  const c = w.config.config;
  Object.assign(c, {
    quoteMint: WSOL_MINT,
    feeClaimer: p.launchAuthority,
    leftoverReceiver: p.launchAuthority,
    collectFeeMode: 0,
    migrationOption: 1,
    activationType: 1,
    tokenDecimal: 6,
    tokenType: 1,
    partnerPermanentLockedLiquidityPercentage: 100,
    migrationFeeOption: 2,
    tokenUpdateAuthority: 1,
    migrationQuoteThreshold: THRESHOLD,
  });
  (c["poolFees"] as { baseFee: Record<string, unknown> }).baseFee["cliffFeeNumerator"] = 10_000_000n;
  w.config.transferHookProgram = PROGRAM_IDS.hook;
  const ps = w.poolState["poolState"] as Record<string, unknown>;
  Object.assign(ps, {
    config: p.dbcConfig,
    creator: p.launchAuthority,
    baseMint: mint,
    baseVault: dbcTokenVaultAddress(mint, pool),
    quoteVault: dbcTokenVaultAddress(WSOL_MINT, pool),
    quoteReserve: 20_000_000_000n,
    baseReserve: 900_000_000_000_000n,
    sqrtPrice: 1n << 60n,
  });

  conn.set(extraAccountMetaListAddress(mint), { owner: PROGRAM_IDS.hook, data: metaListBytes() });
  conn.set(new PublicKey("SysvarC1ock11111111111111111111111111111111"), { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(NOW) });
  upgradeableProgram(conn, PROGRAM_IDS.launchpad, programDataAddress(PROGRAM_IDS.launchpad), 300n, null);
  upgradeableProgram(conn, PROGRAM_IDS.hook, programDataAddress(PROGRAM_IDS.hook), 301n, null);
  upgradeableProgram(conn, PROGRAM_IDS.dbc, programDataAddress(PROGRAM_IDS.dbc), TRUST_ANCHORS.dbcLastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority);
  upgradeableProgram(conn, PROGRAM_IDS.dammV2, programDataAddress(PROGRAM_IDS.dammV2), TRUST_ANCHORS.dammV2LastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority);
  upgradeableProgram(conn, KNOWN_ACCOUNTS.token2022, programDataAddress(KNOWN_ACCOUNTS.token2022), 420_000_000n, TRUST_ANCHORS.token2022UpgradeAuthority);
  // Two DAMM v2 operators.
  for (const [label, permission] of [
    ["op/a", 1n << 4n],
    ["op/b", (1n << 8n) | 1n],
  ] as const) {
    conn.set(key(label + "/acct"), { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Operator", { whitelistedAddress: key(label), permission, padding: [0n, 0n] }) });
  }
  conn.set(protocolAddress(), { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Protocol", { version: 1, bump: 255, treasury, platformFeeBps: 1_000 }) });
  w.build();
  return w;
}


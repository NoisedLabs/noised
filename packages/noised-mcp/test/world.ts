/**
 * A coherent mocked Noised launch with an autopilot, account by account
 * (ported from the SDK's sdk/test/world.ts and autopilot.test.ts): mint
 * bytes as Token-2022 writes them, certificate / launch / policy as the
 * programs write them, DBC and DAMM v2 accounts through the vendored IDLs,
 * the autopilot, its active graph, treasury and pool.
 */
import { createHash } from "node:crypto";

import {
  autopilotPdas,
  buybackBurn,
  burn,
  CERTIFICATE_ALL_CHECKS,
  certificateAddress,
  compileGraph,
  dammV2PoolAddress,
  DAMM_V2_MIGRATION_CONFIGS,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  distributeSol,
  every,
  extraAccountMetaListAddress,
  graph,
  graphHash,
  graphRecordAddress,
  hookPolicyAddress,
  idlCodecs,
  KNOWN_ACCOUNTS,
  launchPdas,
  programDataAddress,
  PROGRAM_IDS,
  protocolAddress,
  TRUST_ANCHORS,
  when,
  whenever,
  WSOL_MINT,
  wsolAta,
  type Graph,
} from "@noisedlabs/sdk";
import { PublicKey } from "@solana/web3.js";

import { concatBytes, ext, key, MockConnection, mintBytes, SPL, T22, tokenAccountBytes, u32le, u64le, upgradeableProgram, wallet } from "./helpers.js";

export const NOW = 1_800_000_000;
export const SUPPLY = 1_000_000_000_000_000n;
export const THRESHOLD = 85_000_000_000n;
export const SOL = 1_000_000_000n;
export const OPERATOR = key("ap/operator");
export const REF = 1n << 59n;
// Graph payees are wallets: the SDK refuses to publish a graph paying an off-curve address with no account (audit 4, C1).
const recipients = [wallet("ap/recipient/0"), wallet("ap/recipient/1")];

const codec = idlCodecs();
const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());

export function accountBytes(idl: "launchpad" | "hook" | "dbc" | "dammV2" | "autopilot", name: string, value: unknown): Uint8Array {
  return concatBytes([codec[idl].accountDiscriminator(name), codec[idl].encodeType(name, value)]);
}

export function zeroed(idl: "dbc" | "dammV2", name: string): Record<string, unknown> {
  const size = codec[idl].accountSize(name);
  return codec[idl].decodeAccount<Record<string, unknown>>(name, concatBytes([codec[idl].accountDiscriminator(name), new Uint8Array(size - 8)]));
}

function metaListBytes(): Uint8Array {
  const disc = sha256(new TextEncoder().encode("spl-transfer-hook-interface:execute")).slice(0, 8);
  const config = new Uint8Array(32);
  config.set([1, 6, ...new TextEncoder().encode("policy"), 3, 1]);
  const policy = concatBytes([Uint8Array.of(1), config, Uint8Array.of(0, 0)]);
  const sysvar = concatBytes([Uint8Array.of(0), KNOWN_ACCOUNTS.sysvarInstructions.toBytes(), Uint8Array.of(0, 0)]);
  return concatBytes([disc, u32le(74), u32le(2), policy, sysvar]);
}

function clock(unix: number): Uint8Array {
  return concatBytes([u64le(400_000_000n), u64le(0n), u64le(900n), u64le(901n), u64le(BigInt(unix))]);
}

/** The graph the tests run: a keeper buyback, a burn, a distribution, an operator-only buyback. */
export const G: Graph = graph({ operator: OPERATOR.toBase58() })
  .recipient(recipients[0]!.toBase58(), "70%", "team")
  .recipient(recipients[1]!.toBase58(), "30%")
  .node("buy", every("1h"), when.graduated(), buybackBurn({ maxIn: 1, maxPremiumBps: 300 }), { maxRunsPerEpoch: 24, budgetPerEpoch: 24 })
  .node("burn", every("1d"), null, burn(1_000))
  .node("share", every("1d"), null, distributeSol(0.5))
  .node("ai", whenever(), when.graduated(), buybackBurn({ maxIn: 0.5 }), { operatorGated: true, budgetPerEpoch: 2, maxRunsPerEpoch: 4 })
  .build();
export const G_BYTES = compileGraph(G);

export const RECIPIENTS = recipients;

export interface World {
  conn: MockConnection;
  mint: PublicKey;
  launch: PublicKey;
  creator: PublicKey;
  autopilot: PublicKey;
  pool: PublicKey;
  /** Rewrites the mint with another on-chain name (e.g. a prompt-injection attempt). */
  setTokenName(name: string, symbol?: string): void;
}

export interface WorldOptions {
  tokenName?: string;
  withAutopilot?: boolean;
  lastRun?: Record<number, number>;
  /** What partial buybacks moved of a node's open run (the program's `partial_spent`). */
  partialSpent?: Record<number, bigint>;
  /** Which graph recipients have a wSOL account (default: both). */
  recipientAccounts?: readonly boolean[];
  /** The treasury's wSOL (default 50 SOL). */
  treasurySol?: bigint;
  /** The pool's wSOL (default 200 SOL). */
  poolSol?: bigint;
  /** The launch graduated: the autopilot's pool is bound (default true). */
  graduated?: boolean;
}


export function world(o: WorldOptions = {}): World {
  const conn = new MockConnection();
  const mint = key("verify/mint");
  const creator = key("verify/creator");
  const treasury = key("verify/treasury");
  const seed = sha256(new TextEncoder().encode("verify/seed"));
  const pqIdentity = sha256(new TextEncoder().encode("verify/pq-identity"));
  const p = launchPdas(creator, seed);
  const dbcPool = dbcPoolAddress(p.dbcConfig, mint, WSOL_MINT);
  const launchTs = BigInt(NOW - 1_000);
  const openDelay = 300;
  const guard = 6 * 3600;
  const commitEnd = launchTs + BigInt(openDelay);
  const executeEnd = commitEnd + 600n;
  const guardEnd = launchTs + BigInt(guard);
  const recipientsFee = [
    { wallet: key("verify/r1"), bps: 7_000 },
    { wallet: key("verify/r2"), bps: 3_000 },
    { wallet: PublicKey.default, bps: 0 },
    { wallet: PublicKey.default, bps: 0 },
  ];
  const paramsHash = sha256(new TextEncoder().encode("params"));
  const [, certBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("certificate"), mint.toBytes()], PROGRAM_IDS.launchpad);
  const maxWallet = (SUPPLY * 100n) / 10_000n;
  const maxBuy = (SUPPLY * 50n) / 10_000n;

  const putMint = (name: string, symbol: string): void => {
    conn.set(mint, {
      owner: T22,
      data: mintBytes({
        supply: SUPPLY,
        decimals: 6,
        extensions: [ext.metadataPointer(null, mint), ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook), ext.tokenMetadata({ updateAuthority: null, mint, name, symbol, uri: "" })],
      }),
    });
  };
  putMint(o.tokenName ?? "Verified", "VER");

  conn.set(certificateAddress(mint), {
    owner: PROGRAM_IDS.launchpad,
    data: accountBytes("launchpad", "Certificate", {
      version: 4,
      bump: certBump,
      launch: p.launch,
      baseMint: mint,
      pool: dbcPool,
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
      recipients: recipientsFee,
      paramsHash,
      policyVersion: 3,
      pqIdentity,
      pqLeaf: 511,
      attestedSlot: 399_999_000n,
      metadata: PublicKey.default,
      // Certificate v4 (P1c): no creator rules.
      rulesHash: new Uint8Array(32),
    }),
  });
  conn.set(p.launch, {
    owner: PROGRAM_IDS.launchpad,
    data: accountBytes("launchpad", "Launch", {
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
      pool: dbcPool,
      treasury,
      platformFeeBps: 1_000,
      recipients: recipientsFee,
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
    }),
  });
  const config = zeroed("dbc", "ConfigWithTransferHook") as Record<string, unknown> & { config: Record<string, unknown> };
  Object.assign(config.config, {
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
  (config.config["poolFees"] as { baseFee: Record<string, unknown> }).baseFee["cliffFeeNumerator"] = 10_000_000n;
  config["transferHookProgram"] = PROGRAM_IDS.hook;
  conn.set(p.dbcConfig, { owner: PROGRAM_IDS.dbc, data: accountBytes("dbc", "ConfigWithTransferHook", config) });
  const poolState = zeroed("dbc", "TransferHookPool");
  Object.assign(poolState["poolState"] as Record<string, unknown>, {
    config: p.dbcConfig,
    creator: p.launchAuthority,
    baseMint: mint,
    baseVault: dbcTokenVaultAddress(mint, dbcPool),
    quoteVault: dbcTokenVaultAddress(WSOL_MINT, dbcPool),
    quoteReserve: 20_000_000_000n,
    baseReserve: 900_000_000_000_000n,
    sqrtPrice: 1n << 60n,
  });
  conn.set(dbcPool, { owner: PROGRAM_IDS.dbc, data: accountBytes("dbc", "TransferHookPool", poolState) });
  conn.set(hookPolicyAddress(mint), {
    owner: PROGRAM_IDS.hook,
    data: accountBytes("hook", "HookPolicy", {
      version: 2,
      bump: 250,
      mint,
      pool: dbcPool,
      baseVault: dbcTokenVaultAddress(mint, dbcPool),
      launchTs,
      snipeShieldEndTs: executeEnd,
      guardEndTs: guardEnd,
      maxWallet,
      maxBuy,
      p2pLocked: false,
      exempt: [p.batchAuthority, p.launchAuthority, PublicKey.default, PublicKey.default],
      // HookPolicy v2 (P1c): the creator rules (none).
      rules: new Uint8Array(0),
    }),
  });
  conn.set(extraAccountMetaListAddress(mint), { owner: PROGRAM_IDS.hook, data: metaListBytes() });
  conn.set(new PublicKey("SysvarC1ock11111111111111111111111111111111"), { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(NOW) });
  upgradeableProgram(conn, PROGRAM_IDS.launchpad, programDataAddress(PROGRAM_IDS.launchpad), 300n, null);
  upgradeableProgram(conn, PROGRAM_IDS.hook, programDataAddress(PROGRAM_IDS.hook), 301n, null);
  upgradeableProgram(conn, PROGRAM_IDS.dbc, programDataAddress(PROGRAM_IDS.dbc), TRUST_ANCHORS.dbcLastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority);
  upgradeableProgram(conn, PROGRAM_IDS.dammV2, programDataAddress(PROGRAM_IDS.dammV2), TRUST_ANCHORS.dammV2LastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority);
  upgradeableProgram(conn, KNOWN_ACCOUNTS.token2022, programDataAddress(KNOWN_ACCOUNTS.token2022), 420_000_000n, TRUST_ANCHORS.token2022UpgradeAuthority);
  conn.set(protocolAddress(), { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Protocol", { version: 1, bump: 255, treasury, platformFeeBps: 1_000 }) });

  // ---- the autopilot: mint bound, graduated, G active, observed for the last 10 minutes at the reference.
  const ap = autopilotPdas(p.launch, mint);
  const hash = graphHash(G_BYTES);
  const dammPool = dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, mint, WSOL_MINT);
  if (o.withAutopilot !== false) {
    const node = { lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n };
    const partialSpent = Array.from({ length: 16 }, (_, i) => o.partialSpent?.[i] ?? 0n);
    conn.set(ap.autopilot, {
      owner: PROGRAM_IDS.autopilot,
      // The 1,244-byte account (audit 4: active_auth, active_activate_at, partial_spent), encoded by the SDK's IDL.
      data: accountBytes("autopilot", "Autopilot", {
        version: 1,
        bump: 255,
        treasuryBump: 254,
        launch: p.launch,
        mint,
        dammPool: o.graduated === false ? PublicKey.default : dammPool,
        activeGraph: hash,
        pendingGraph: new Uint8Array(32),
        pendingActivateAt: 0n,
        pendingOperator: PublicKey.default,
        activatedAt: BigInt(NOW - 86_400),
        frozen: false,
        operator: OPERATOR,
        authMarks: [0, 1, 2].map(() => ({ slot: 0n, key: PublicKey.default })),
        seq: o.lastRun === undefined ? 0n : 1n,
        refSqrtPrice: REF,
        refUpdatedAt: 0n,
        refAllowance: 0n,
        refAllowanceAt: 0n,
        observations: [
          { index: BigInt(Math.floor(NOW / 900)), firstAt: BigInt(NOW - 600), min: REF, max: REF },
          { index: BigInt(Math.floor(NOW / 900) - 1), firstAt: BigInt(NOW - 900), min: REF, max: REF },
        ],
        tipEpochStart: 0n,
        tipsInEpoch: 0n,
        nodes: Array.from({ length: 16 }, (_, i) => (o.lastRun?.[i] === undefined ? { ...node } : { ...node, lastRun: BigInt(o.lastRun[i]), lastSeq: 1n, epochStart: BigInt(o.lastRun[i]), runsInEpoch: 1 })),
        activeAuth: PublicKey.default,
        activeActivateAt: 0n,
        partialSpent,
      }),
    });
    conn.set(graphRecordAddress(p.launch, hash), { owner: PROGRAM_IDS.autopilot, data: accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch: p.launch, graphHash: hash, bytes: G_BYTES }) });
    conn.set(ap.treasuryWsol, { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: ap.treasury, amount: o.treasurySol ?? 50n * SOL }) });
    // The graph's recipients' own wSOL accounts (they create them; nobody else pays for them).
    recipients.forEach((r, i) => {
      if (o.recipientAccounts?.[i] ?? true) conn.set(wsolAta(r), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: r, amount: 0n }) });
    });
    conn.set(ap.treasuryToken!, { owner: T22, data: tokenAccountBytes({ mint, owner: ap.treasury, amount: 5_000_000_000n, token2022: true }) });
    const pool = zeroed("dammV2", "Pool");
    Object.assign(pool, { tokenAMint: mint, tokenBMint: WSOL_MINT, tokenAVault: key("ap/va"), tokenBVault: key("ap/vb"), creator: KNOWN_ACCOUNTS.dbcPoolAuthority, sqrtPrice: REF });
    conn.set(dammPool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", pool) });
    conn.set(key("ap/vb"), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: KNOWN_ACCOUNTS.dammV2PoolAuthority, amount: o.poolSol ?? 200n * SOL }) });
  }

  return { conn, mint, launch: p.launch, creator, autopilot: ap.autopilot, pool: dammPool, setTokenName: (name, symbol = "VER") => putMint(name, symbol) };
}

/**
 * MOCK fixtures: a handful of launches in every phase, with timestamps
 * relative to the moment the demo state was seeded so phases advance live.
 * Addresses are derived like on chain (PDAs with the real seeds and program
 * ids); keys that would be fresh keypairs come from fixed demo labels.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  attestationAddress,
  buildMetadataDoc,
  capFromBps,
  certificateAddress,
  CERTIFICATE,
  CERTIFICATE_ALL_CHECKS,
  CERTIFICATE_RULES_BOUND,
  commitAddress,
  DAMM_V2_MIGRATION_CONFIGS,
  dammV2PoolAddress,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  decodeTokenMeta,
  estimateSupply,
  KNOWN_ACCOUNTS,
  launchParamsHash,
  launchPdas,
  metadataHashV2,
  MIGRATION_FEE_TIERS_BPS,
  POLICY,
  PRESETS,
  PQ_IDENTITY,
  pqIdentity,
  PROGRAM_IDS,
  shieldAddresses,
  tokenMetaAccountData,
  tokenMetaAddress,
  validateTokenMeta,
  WSOL_MINT,
  type AttestationAccount,
  type FeeRecipient,
  type LaunchParams,
  type LaunchState,
  type PresetName,
  type TokenMetaAccount,
  type TokenMetaInput,
} from "@noisedlabs/sdk";
import { PublicKey } from "@solana/web3.js";

import { utf8 } from "./bytes";
import { demoRulesHash } from "./demoRules";
import { demoKey } from "./keys";
import { applySwap, executeBatch, simulateSwap } from "./market";
import { DEMO_MINTS } from "./mints";
import type { MockLaunch, MockState } from "./store";

const SOL = POLICY.LAMPORTS_PER_SOL;

/** The (immutable) protocol treasury of the demo deployment and its platform share. */
export const DEMO_TREASURY = demoKey("treasury");
export const DEMO_PLATFORM_FEE_BPS = 2_000;

function bump(seeds: Uint8Array[], program: PublicKey): number {
  return PublicKey.findProgramAddressSync(seeds, program)[1];
}

/**
 * The PQ identity id (`SHA256(0x21 || LMS public key)`) of a demo creator.
 * Stand-in bytes: the simulated chain never re-verifies an LMS signature, so
 * no LMS tree is built for the fixtures (a real one takes about a second).
 */
export function demoIdentityId(label: string): Uint8Array {
  // demo derivation tag, kept from the original name: changing it changes every simulated identity and address
  return sha256(utf8(`phalanx-demo/pq-identity/${label}`));
}

/**
 * What `publish_metadata` writes: the TokenMeta record of `metadata` under
 * `launch`, at the address of its own hash (`["metadata", launch,
 * metadata_hash_v2]`), as the exact account bytes. Idempotent like the
 * program (an existing record is left as it is); refuses what the program
 * refuses. A stand-in until the mock has the publish builder.
 */
export function publishDemoTokenMeta(s: MockState, launch: PublicKey, metadata: TokenMetaInput): TokenMetaAccount {
  const v = validateTokenMeta(metadata);
  if (!v.ok) throw new Error(`invalid metadata record:\n${v.errors.join("\n")}`);
  const address = tokenMetaAddress(launch, metadataHashV2(metadata));
  const id = address.toBase58();
  const data = (s.tokenMetas[id] ??= tokenMetaAccountData(launch, metadata));
  return decodeTokenMeta(address, data);
}

/** The record the simulated chain holds at `["metadata", launch, metadataHash]`, decoded; null when none was published. */
export function tokenMetaAt(s: MockState, launch: PublicKey, metadataHash: Uint8Array): TokenMetaAccount | null {
  const address = tokenMetaAddress(launch, metadataHash);
  const data = s.tokenMetas[address.toBase58()];
  return data === undefined ? null : decodeTokenMeta(address, data);
}

/**
 * The attestation `attest_launch` would have written for `l`: the creator's
 * identity signed the launch, its parameters, the metadata record `metadata`
 * (by its `metadata_hash_v2`) and the window `notBefore..=notAfter` (unix
 * seconds). The message is the real 189-byte v2 one; the stored signature is
 * a stand-in (all zero) because the simulated chain does not run LMS
 * verification. The record itself is published separately
 * (`publishDemoTokenMeta`): `launch` refuses without it.
 */
export function demoAttestation(l: MockLaunch, metadata: TokenMetaInput, window: { notBefore: bigint; notAfter: bigint }, slot: number, rulesHash: Uint8Array = new Uint8Array(32)): AttestationAccount {
  const metadataHash = metadataHashV2(metadata);
  const message = pqIdentity.attestationMessage({
    launch: l.address,
    paramsHash: l.state.paramsHash,
    creator: l.state.creator,
    metadataHash,
    notBefore: window.notBefore,
    notAfter: window.notAfter,
  });
  return {
    publicKey: attestationAddress(l.address),
    version: PQ_IDENTITY.ATTESTATION_VERSION,
    bump: bump([utf8("attestation"), l.address.toBytes()], PROGRAM_IDS.launchpad),
    attested: true,
    launch: l.address,
    pqIdentity: Uint8Array.from(l.state.pqIdentity),
    leaf: (sha256(message)[0] ?? 0) * 4,
    metadataHash,
    messageHash: sha256(message),
    slot: BigInt(slot),
    notBefore: window.notBefore,
    notAfter: window.notAfter,
    signature: new Uint8Array(PQ_IDENTITY.SIGNATURE_LEN),
    // Attestation v3: the creator rules it binds (all zero: none; the demo's rules are ./demoRules.ts).
    rulesHash: Uint8Array.from(rulesHash),
  };
}

export interface FixtureSpec {
  symbol: string;
  name: string;
  /** The record's document: a description and a website (the demo's icons are its hand-made art, shown in demo builds only). */
  description: string;
  website: string;
  preset: PresetName;
  overrides?: Partial<Omit<LaunchParams, "recipients">>;
  createdAgoSecs: number;
  /** null: configured, not launched yet. */
  launchedAgoSecs: number | null;
  totalCommittedSol: number;
  keeper: boolean;
  /** Fraction of the threshold reached by public trading after the batch (>= 1 completes the curve). */
  progress: number;
  migratedAgoSecs?: number;
  /** DAMM v2 fee an operator set after migration (bps), if different from the tier. */
  operatorFeeBps?: number;
  recipients: { label: string; bps: number }[];
}

export const FIXTURES: readonly FixtureSpec[] = [
  {
    symbol: "AEGS",
    name: "Aegis",
    description: "A shield for a community treasury: fees fund the Aegis DAO.",
    website: "https://aegis.example",
    preset: "fair",
    // Oversubscribed: 61.4 SOL committed for a 40 SOL cap, so about 65% of every commit is spent.
    overrides: { openDelaySecs: 900, guardSecs: 6 * 3600, batchTotalCap: 40n * SOL },
    createdAgoSecs: 260,
    launchedAgoSecs: 150,
    totalCommittedSol: 61.4,
    keeper: true,
    progress: 0,
    recipients: [
      { label: "aegis-dao", bps: 7_000 },
      { label: "aegis-dev", bps: 3_000 },
    ],
  },
  {
    symbol: "BSTN",
    name: "Bastion",
    description: "A slow, steady community token with a one-day launch guard.",
    website: "https://bastion.example",
    preset: "community",
    // Executed oversubscribed: the batch spent its 150 SOL cap and claims refund the rest pro rata.
    overrides: { batchTotalCap: 150n * SOL },
    createdAgoSecs: 3 * 3600,
    launchedAgoSecs: 2.5 * 3600,
    totalCommittedSol: 182.75,
    keeper: true,
    progress: 0.81,
    recipients: [{ label: "bastion-treasury", bps: 10_000 }],
  },
  {
    symbol: "LNTN",
    name: "Lantern",
    description: "Lights for night markets, paid in Lantern.",
    website: "https://lantern.example",
    preset: "fair",
    createdAgoSecs: 31 * 3600,
    launchedAgoSecs: 30 * 3600,
    totalCommittedSol: 44.2,
    keeper: true,
    progress: 0.58,
    recipients: [
      { label: "lantern-a", bps: 5_000 },
      { label: "lantern-b", bps: 2_500 },
      { label: "lantern-c", bps: 2_500 },
    ],
  },
  {
    symbol: "MRDN",
    name: "Meridian",
    description: "Meridian graduated to its locked pool on day one.",
    website: "https://meridian.example",
    preset: "fair",
    createdAgoSecs: 5 * 86_400 + 600,
    launchedAgoSecs: 5 * 86_400,
    totalCommittedSol: 52.9,
    keeper: true,
    progress: 1,
    migratedAgoSecs: 4 * 86_400,
    recipients: [{ label: "meridian-labs", bps: 10_000 }],
  },
  {
    symbol: "CNDR",
    name: "Cinder",
    description: "A fast turbo launch: one-minute batch, one-hour guard.",
    website: "https://cinder.example",
    preset: "turbo",
    createdAgoSecs: 9 * 86_400 + 300,
    launchedAgoSecs: 9 * 86_400,
    totalCommittedSol: 18.3,
    keeper: true,
    progress: 1,
    migratedAgoSecs: 8.5 * 86_400,
    operatorFeeBps: 1_000,
    recipients: [
      { label: "cinder-1", bps: 6_000 },
      { label: "cinder-2", bps: 4_000 },
    ],
  },
  {
    symbol: "EMBR",
    name: "Ember",
    description: "Ember's opening batch closed without anyone starting it, so every commit was refunded.",
    website: "https://ember.example",
    preset: "fair",
    createdAgoSecs: 70 * 60,
    launchedAgoSecs: 50 * 60,
    totalCommittedSol: 23.6,
    keeper: false,
    progress: 0.07,
    recipients: [{ label: "ember-team", bps: 10_000 }],
  },
  {
    symbol: "QRY",
    name: "Quarry",
    description: "Quarry is set up and signed: anyone can open it during its hour.",
    website: "https://quarry.example",
    preset: "community",
    createdAgoSecs: 12 * 60,
    launchedAgoSecs: null,
    totalCommittedSol: 0,
    keeper: true,
    progress: 0,
    recipients: [{ label: "quarry", bps: 10_000 }],
  },
];

/** A demo token's record: its name, symbol and a document with its description and website (never a uri mode). */
export function fixtureMetadata(f: Pick<FixtureSpec, "name" | "symbol" | "description" | "website">): TokenMetaInput {
  return { name: f.name, symbol: f.symbol, doc: buildMetadataDoc({ name: f.name, symbol: f.symbol, description: f.description, links: { website: f.website } }) };
}

function recipientsOf(spec: FixtureSpec): FeeRecipient[] {
  return spec.recipients.map((r) => ({ wallet: demoKey(`recipient/${r.label}`), bps: r.bps }));
}

function padRecipients(rs: FeeRecipient[]): FeeRecipient[] {
  const out = rs.map((r) => ({ ...r }));
  while (out.length < POLICY.MAX_RECIPIENTS) out.push({ wallet: PublicKey.default, bps: 0 });
  return out;
}

/** The Launch account + market state right after `create_launch`. */
export function newMockLaunch(args: { launchSeed: Uint8Array; creator: PublicKey; params: LaunchParams }): MockLaunch {
  const { launchSeed, creator, params } = args;
  const pdas = launchPdas(creator, launchSeed);
  const lp = (seed: string): number => bump([utf8(seed), pdas.launch.toBytes()], PROGRAM_IDS.launchpad);
  const state: LaunchState = {
    version: 1,
    bump: bump([utf8("launch"), creator.toBytes(), launchSeed], PROGRAM_IDS.launchpad),
    authorityBump: lp("authority"),
    batchBump: lp("batch"),
    configBump: lp("dbc-config"),
    status: "configured",
    launchSeed,
    creator,
    dbcConfig: pdas.dbcConfig,
    launchAuthority: pdas.launchAuthority,
    batchAuthority: pdas.batchAuthority,
    baseMint: PublicKey.default,
    pool: PublicKey.default,
    treasury: DEMO_TREASURY,
    platformFeeBps: DEMO_PLATFORM_FEE_BPS,
    recipients: padRecipients(params.recipients),
    recipientCount: params.recipients.length,
    tokenDecimal: params.tokenDecimal,
    migrationQuoteThreshold: params.migrationQuoteThreshold,
    migrationFeeOption: params.migrationFeeOption,
    openDelaySecs: params.openDelaySecs,
    guardSecs: params.guardSecs,
    maxWalletBps: params.maxWalletBps,
    maxBuyBps: params.maxBuyBps,
    p2pLocked: params.p2pLocked,
    batchWalletCap: params.batchWalletCap,
    batchTotalCap: params.batchTotalCap === 0n ? params.migrationQuoteThreshold : params.batchTotalCap,
    paramsHash: launchParamsHash(params),
    launchTs: 0n,
    commitEndTs: 0n,
    executeEndTs: 0n,
    guardEndTs: 0n,
    totalCommitted: 0n,
    executed: false,
    quoteSpent: 0n,
    tokensOut: 0n,
    tokensClaimed: 0n,
    quoteRefunded: 0n,
    pqIdentity: Uint8Array.from(params.pqIdentity),
  };
  const initialSupply = 1_000_000_000n * 10n ** BigInt(params.tokenDecimal);
  const curveBase = estimateSupply(params.sqrtStartPrice, params.curve, params.migrationQuoteThreshold)?.curveBase ?? 0n;
  const baseReserve = curveBase > 0n && curveBase < initialSupply ? curveBase : (initialSupply * 8n) / 10n;
  const s = Number(params.sqrtStartPrice) / 2 ** 64;
  const virtualQuote = BigInt(Math.round(s * s * Number(baseReserve)));
  const floorFeeBps = Number((params.baseFee.cliffFeeNumerator * 10_000n) / 1_000_000_000n);
  const tier = MIGRATION_FEE_TIERS_BPS[params.migrationFeeOption] ?? 100;
  return {
    address: pdas.launch,
    state,
    meta: null,
    initialSupply,
    quoteReserve: 0n,
    baseReserve,
    virtualQuote,
    feeBps: floorFeeBps,
    curveComplete: false,
    completedAt: null,
    migrated: false,
    dammPool: null,
    positionNftMint: null,
    dammTierBps: tier,
    dammFeeBps: tier,
    dammStatus: "enabled",
    keeper: true,
    feesClaimable: 0n,
    lpFeesQuote: 0n,
    lpFeesBase: 0n,
    authorityQuote: 0n,
    authorityBase: 0n,
    certificate: null,
    maxWallet: 0n,
    maxBuy: 0n,
    baseVault: null,
    hasSwap: false,
  };
}

/**
 * Apply `launch`: pool, mint, hook policy and certificate (which records the attestation's identity, leaf and slot and
 * the metadata record's address). The mint's name and symbol are the record's and its uri is the one derived from it
 * (empty unless the record has a uri mode).
 */
export function goLive(l: MockLaunch, args: { baseMint: PublicKey; launchTs: number; record: TokenMetaAccount; attestation: AttestationAccount }): void {
  const st = l.state;
  const pool = dbcPoolAddress(st.dbcConfig, args.baseMint, WSOL_MINT);
  st.status = "live";
  st.baseMint = args.baseMint;
  st.pool = pool;
  st.launchTs = BigInt(args.launchTs);
  st.commitEndTs = st.launchTs + BigInt(st.openDelaySecs);
  st.executeEndTs = st.commitEndTs + BigInt(POLICY.EXECUTION_GRACE_SECS);
  st.guardEndTs = st.launchTs + BigInt(st.guardSecs);
  l.meta = { name: args.record.name, symbol: args.record.symbol, uri: args.record.tokenUri };
  l.baseVault = dbcTokenVaultAddress(args.baseMint, pool);
  // The launchpad writes these caps into the hook policy (`policy::cap_from_bps`).
  l.maxWallet = capFromBps(l.initialSupply, st.maxWalletBps) ?? 0n;
  l.maxBuy = capFromBps(l.initialSupply, st.maxBuyBps) ?? 0n;
  l.certificate = {
    publicKey: certificateAddress(args.baseMint),
    version: CERTIFICATE.VERSION,
    bump: bump([utf8("certificate"), args.baseMint.toBytes()], PROGRAM_IDS.launchpad),
    launch: l.address,
    baseMint: args.baseMint,
    pool,
    dbcConfig: st.dbcConfig,
    creator: st.creator,
    launchedAt: st.launchTs,
    tokenDecimal: st.tokenDecimal,
    initialSupply: l.initialSupply,
    // Certificate v4: RULES_BOUND is set in addition when the attestation bound creator rules.
    checks: CERTIFICATE_ALL_CHECKS | (args.attestation.rulesHash.some((b) => b !== 0) ? CERTIFICATE_RULES_BOUND : 0),
    migrationQuoteThreshold: st.migrationQuoteThreshold,
    migrationFeeOption: st.migrationFeeOption,
    snipeShieldEndTs: st.executeEndTs,
    executeEndTs: st.executeEndTs,
    guardEndTs: st.guardEndTs,
    maxWallet: l.maxWallet,
    maxBuy: l.maxBuy,
    p2pLocked: st.p2pLocked,
    platformFeeBps: st.platformFeeBps,
    recipients: st.recipients.map((r) => ({ ...r })),
    paramsHash: st.paramsHash,
    policyVersion: POLICY.SAFETY_POLICY_VERSION,
    pqIdentity: Uint8Array.from(args.attestation.pqIdentity),
    pqLeaf: args.attestation.leaf,
    attestedSlot: args.attestation.slot,
    metadata: args.record.publicKey,
    // Certificate v4: the rules the attestation bound (all zero: none).
    rulesHash: Uint8Array.from(args.attestation.rulesHash),
  };
}

/** The batch buy, crediting the batch escrow. */
export function runBatch(s: MockState, l: MockLaunch): void {
  executeBatch(l);
  const key = `${l.state.batchAuthority.toBase58()}:${l.state.baseMint.toBase58()}`;
  s.tokens[key] = (s.tokens[key] ?? 0n) + l.state.tokensOut;
}

/** Keeper: DBC `migration_damm_v2` (permissionless). 100% of the LP is permanently locked. */
export function migrate(l: MockLaunch): void {
  const config = DAMM_V2_MIGRATION_CONFIGS[l.state.migrationFeeOption] ?? DAMM_V2_MIGRATION_CONFIGS[0];
  if (!config) throw new Error("missing DAMM v2 migration config");
  l.migrated = true;
  // DBC migrates with the base mint as token A and the quote mint as token B.
  l.dammPool = dammV2PoolAddress(config, l.state.baseMint, WSOL_MINT);
  l.positionNftMint = demoKey(`position-nft/${l.address.toBase58()}`);
}

/** Aggregate public trading until the pool holds `fraction` of the threshold. */
function tradeTo(l: MockLaunch, fraction: number): void {
  const target = BigInt(Math.floor(Number(l.state.migrationQuoteThreshold) * Math.min(fraction, 1)));
  if (l.quoteReserve >= target) return;
  const gap = target - l.quoteReserve;
  const gross = (gap * 10_000n) / BigInt(10_000 - l.feeBps) + 1n;
  applySwap(l, "buy", simulateSwap(l, "buy", fraction >= 1 ? gross * 2n : gross));
}

export function seedState(): MockState {
  const now = Math.floor(Date.now() / 1000);
  const s: MockState = {
    version: 7,
    seededAt: now,
    slot: 447_812_000 + Math.floor(Math.random() * 1000),
    launches: {},
    commits: {},
    attestations: {},
    tokenMetas: {},
    identities: {},
    payoutVaults: {},
    sol: {},
    tokens: {},
    vaults: {},
    payouts: {},
    vaultHistory: {},
    frozen: {},
    shields: {},
    landed: {},
    funded: {},
  };
  for (const f of FIXTURES) {
    const preset = PRESETS[f.preset];
    const params: LaunchParams = { ...preset.params, ...(f.overrides ?? {}), recipients: recipientsOf(f), pqIdentity: demoIdentityId(`creator/${f.symbol}`) };
    const l = newMockLaunch({
      // demo derivation tag, kept from the original name (simulated addresses)
      launchSeed: sha256(utf8(`phalanx-demo/launch/${f.symbol}`)),
      creator: demoKey(`creator/${f.symbol}`),
      params,
    });
    l.keeper = f.keeper;
    s.launches[l.address.toBase58()] = l;
    // The token's record (name, symbol and a document with its description and website; no uri, as the app launches
    // it), published before the attestation.
    const metadata = fixtureMetadata(f);
    const record = publishDemoTokenMeta(s, l.address, metadata);
    if (f.launchedAgoSecs === null) {
      // Attested and waiting for its window: anyone may open it from `notBefore` (the creator's signature allows nothing else).
      const opensAt = BigInt(now - 60);
      s.attestations[l.address.toBase58()] = demoAttestation(l, metadata, { notBefore: opensAt, notAfter: opensAt + 3_600n }, s.slot - 400);
      continue;
    }
    const launchTs = now - Math.round(f.launchedAgoSecs);
    // A launch with creator rules binds their hash: its certificate records it and carries RULES_BOUND (8,191).
    const attestation = demoAttestation(l, metadata, { notBefore: BigInt(launchTs - 30), notAfter: BigInt(launchTs + 3_570) }, s.slot - 9_000 - Math.round(f.launchedAgoSecs * 2.5), demoRulesHash(f.symbol, l.state));
    s.attestations[l.address.toBase58()] = attestation;
    goLive(l, { baseMint: demoKey(`mint/${f.symbol}`), launchTs, record, attestation });
    l.state.totalCommitted = BigInt(Math.round(f.totalCommittedSol * 1e9));
    const executeAt = Number(l.state.commitEndTs) + 12;
    if (f.keeper && l.state.totalCommitted > 0n && now >= executeAt) runBatch(s, l);
    if (now >= Number(l.state.executeEndTs) && f.progress > 0) tradeTo(l, f.progress);
    if (l.curveComplete) l.completedAt = now - Math.round((f.migratedAgoSecs ?? 0) + 60);
    if (f.migratedAgoSecs !== undefined && l.curveComplete) {
      migrate(l);
      if (f.operatorFeeBps !== undefined) l.dammFeeBps = f.operatorFeeBps;
      l.lpFeesQuote = BigInt(Math.round(3.4 * 1e9));
      l.lpFeesBase = 120_000n * 10n ** BigInt(l.state.tokenDecimal);
    }
    if (l.state.executed && !l.migrated) l.feesClaimable = (l.quoteReserve * BigInt(l.feeBps) * 8n) / 100_000n;
  }
  const meridian = Object.values(s.launches).find((l) => l.meta?.symbol === "MRDN");
  if (meridian) {
    const mint = meridian.state.baseMint;
    const addrs = shieldAddresses(mint);
    const zSupply = 1_250_000n * 10n ** BigInt(meridian.state.tokenDecimal);
    s.shields[mint.toBase58()] = {
      account: {
        publicKey: addrs.shield,
        version: 1,
        bump: bump([utf8("shield"), mint.toBytes()], PROGRAM_IDS.shield),
        authorityBump: bump([utf8("shield-authority"), mint.toBytes()], PROGRAM_IDS.shield),
        zMintBump: bump([utf8("z-mint"), mint.toBytes()], PROGRAM_IDS.shield),
        decimals: meridian.state.tokenDecimal,
        baseMint: mint,
        baseTokenProgram: KNOWN_ACCOUNTS.token2022,
        zMint: addrs.zMint,
        escrow: addrs.escrow,
        createdAt: BigInt(now - 3 * 86_400),
      },
      zSupply,
    };
    s.tokens[`${addrs.authority.toBase58()}:${mint.toBase58()}`] = zSupply;
  }
  return s;
}

/** Demo balances for an owner the mock has not seen yet. */
export function fundOwner(s: MockState, owner: PublicKey): boolean {
  const id = owner.toBase58();
  if (s.funded[id]) return false;
  s.funded[id] = true;
  s.sol[id] = (s.sol[id] ?? 0n) + 25n * SOL;
  const bySymbol = (sym: string): MockLaunch | undefined => Object.values(s.launches).find((l) => l.meta?.symbol === sym);
  const give = (sym: string, whole: bigint): void => {
    const l = bySymbol(sym);
    if (!l) return;
    const k = `${id}:${l.state.baseMint.toBase58()}`;
    s.tokens[k] = (s.tokens[k] ?? 0n) + whole * 10n ** BigInt(l.state.tokenDecimal);
  };
  give("LNTN", 2_500_000n);
  give("MRDN", 1_800_000n);
  give("CNDR", 600_000n);
  for (const m of DEMO_MINTS) {
    if (m.symbol !== "dUSD" && m.symbol !== "dPAU") continue;
    const k = `${id}:${m.address.toBase58()}`;
    s.tokens[k] = (s.tokens[k] ?? 0n) + 5_000n * 10n ** BigInt(m.decimals);
  }
  const commitTo = (sym: string, lamports: bigint): void => {
    const l = bySymbol(sym);
    if (!l) return;
    const key = `${l.address.toBase58()}:${id}`;
    if (s.commits[key]) return;
    s.commits[key] = {
      publicKey: commitAddress(l.address, owner),
      version: 1,
      bump: bump([utf8("commit"), l.address.toBytes(), owner.toBytes()], PROGRAM_IDS.launchpad),
      launch: l.address,
      owner,
      amount: lamports,
      claimed: false,
      tokenOwner: owner,
      refundOwner: owner,
    };
    const st = l.state;
    // Pretend the demo wallet was in the batch all along. An oversubscribed batch
    // spent exactly its cap: the extra commit only lowers everyone's fill (pro
    // rata, refunded at claim). An undersubscribed one spent everything: grow
    // its buy pro rata so every commit still gets the same price.
    if (st.executed && st.totalCommitted > 0n && st.quoteSpent < st.batchTotalCap) {
      const room = st.batchTotalCap - st.quoteSpent;
      const grow = (st.quoteSpent * lamports) / st.totalCommitted;
      const extraQuote = grow < room ? grow : room;
      const extraTokens = st.quoteSpent === 0n ? 0n : (st.tokensOut * extraQuote) / st.quoteSpent;
      st.quoteSpent += extraQuote;
      st.tokensOut += extraTokens;
      const escrowKey = `${st.batchAuthority.toBase58()}:${st.baseMint.toBase58()}`;
      s.tokens[escrowKey] = (s.tokens[escrowKey] ?? 0n) + extraTokens;
    }
    st.totalCommitted += lamports;
  };
  commitTo("BSTN", 2_500_000_000n);
  commitTo("EMBR", 1_200_000_000n);
  return true;
}

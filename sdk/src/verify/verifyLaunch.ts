/**
 * `verifyLaunch(conn, mint)`: an independent check of a Noised launch
 * against LIVE chain state (SPEC §1.5: the certificate alone is not trusted).
 *
 * Re-checked from the accounts themselves, not from the certificate's flags:
 * - mint: Token-2022 owner, mint and freeze authorities None, extension set
 *   exactly {MetadataPointer, TokenMetadata, TransferHook} (via
 *   `getExtensionTypes` and a strict TLV parse that must agree), metadata and
 *   pointer authorities None, transfer hook = Launch Guard with DBC's pool
 *   authority while the curve runs, program and authority None after;
 * - DBC config: every fixed value of SPEC §1.2 and the fee ceiling;
 * - DBC pool, hook policy (exact values), meta list (exactly the two
 *   canonical metas: the policy PDA and the instructions sysvar);
 * - launch state vs certificate, batch accounting invariants (an
 *   oversubscribed batch is filled pro rata), the batch size: the total cap
 *   as a share of the migration threshold AND the per-wallet cap (a tiny
 *   wallet cap empties the fair open as surely as a tiny total cap), timeline;
 * - post-quantum origin (`./pqOrigin.ts`): the attestation's LMS signature
 *   re-verified against the identity's public key over the message (v3)
 *   rebuilt from on-chain data, the certificate's PQ fields, the launch
 *   window; no attestation, a burn-only one or any mismatch fails ("not
 *   PQ-attested");
 * - the creator's launch rules: the certificate's `rules_hash` is the one
 *   the identity signed, the Launch Guard policy holds exactly the bytes of
 *   the rules record that hash names (none for the zero hash), the
 *   certificate's `RULES_BOUND` flag is set exactly when there are rules
 *   (never on a version-3 certificate), and the rules are valid for the
 *   launch's guard; reported in plain English (`report.rules`);
 * - the on-chain metadata record (`TokenMeta`): found through the
 *   certificate only, at the address of the hash the identity signed, its
 *   hash recomputed; the mint holds exactly its name, symbol and derived uri;
 *   its document read defensively (an inline PNG icon of at most 64x64,
 *   links as text; nothing is ever fetched);
 * - the snipe shield: it ends at the certificate's scheduled end, or earlier
 *   only when the batch executed (`execute_batch` ends it then, through the
 *   hook's `end_snipe_shield`); any other end fails;
 * - after migration: a DAMM v2 position held by the launch authority with
 *   permanently locked liquidity, in a DBC-created (base, wSOL) pool, whose
 *   fee is exactly what DBC's migration sets (the tier plus the canonical
 *   config's dynamic fee, `./dammFees.ts`); anything else is an operator change;
 * - program upgrade authorities and deploy slots (ours, Meteora's, Token-2022).
 *
 * A lying RPC can lie about all of this: for large decisions, run it against
 * two independent RPC providers.
 */
import { getExtensionTypes } from "@solana/spl-token";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from "@solana/web3.js";
import { Buffer } from "buffer";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual, isAllZero, toHex } from "../codec/bytes.js";
import {
  CERTIFICATE,
  CERTIFICATE_ALL_CHECKS,
  CERTIFICATE_CHECKS,
  CERTIFICATE_RULES_BOUND,
  certificateChecksComplete,
  DAMM_V2_MIGRATION_CONFIGS,
  DBC,
  HOOK_BOUNDS,
  KNOWN_ACCOUNTS,
  METADATA,
  MIGRATION_FEE_TIERS_BPS,
  POLICY,
  PROGRAM_IDS,
  TRUST_ANCHORS,
  WSOL_MINT,
} from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { activeRecipients, curveStatus, decodeAttestation, decodeCertificate, decodeHookPolicy, decodeLaunch, decodeLaunchRules } from "../launch/accounts.js";
import { findLaunchLpPositions, type LaunchLpPosition } from "../launch/builders.js";
import { capFromBps, expectedBatchFill, feeNumeratorToBps, feeScheduleDuration, maxVariableFeeNumerator, minBaseFeeNumerator, withinFeeCeiling } from "../launch/policy.js";
import { launchPhase } from "../launch/presets.js";
import { checkNowSecs, plausibleUnixSecs, unixNowSecs } from "../launch/window.js";
import { parseMetadataDoc, type ParsedMetadataDoc } from "../metadata/doc.js";
import { tokenUriBytes } from "../metadata/record.js";
import {
  DAMM_OPERATOR_PERMISSIONS,
  DAMM_POOL_STATUS_ENABLED,
  decodeDammOperator,
  decodeDbcConfigWithTransferHook,
  decodeDbcTransferHookPool,
  type DammOperator,
  type DbcConfigWithTransferHook,
  type DbcPoolState,
} from "../meteora/state.js";
import {
  attestationAddress,
  certificateAddress,
  dammV2PoolAddress,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  extraAccountMetaListAddress,
  hookPolicyAddress,
  identityAddressFromId,
  launchAddress,
  launchPdasFromLaunch,
  launchRulesAddress,
  programDataAddress,
} from "../pda.js";
import { rulesHash } from "../programmable/hash.js";
import { getAccounts, type RawAccount } from "../rpc/fetch.js";
import { upgradeableProgramInfo, type UpgradeableProgramInfo } from "../rpc/programs.js";
import { ExtensionType, extensionName, metadataPointerOf, parseMint, transferHookOf, type ParsedMint } from "../token/mint.js";
import type {
  CertificateAccount,
  CheckStatus,
  HookPolicyAccount,
  LaunchAccount,
  LaunchPhase,
  LaunchRulesAccount,
  PqOrigin,
  TrustedParty,
  VerificationCheck,
  VerificationReport,
  VerifiedMetadata,
  VerifiedRules,
} from "../types.js";
import { compareDammPoolFee, dammFeePercent } from "./dammFees.js";
import { checkPqOrigin, explainLaunchRules, tokenMetadataFields, type OnChainMetadata, type PqOriginResult } from "./pqOrigin.js";

export interface VerifyOptions {
  /** Bigint unix seconds for the phase; default: the cluster's Clock sysvar (local time if unavailable). */
  nowSecs?: bigint | undefined;
  /** List DAMM v2 operator accounts with `getProgramAccounts` (default true). */
  listOperators?: boolean;
}

/**
 * The exact ExtraAccountMetaList the Launch Guard writes (86 bytes, two
 * metas): the PDA `["policy", mint]` of the hook program, then the
 * instructions sysvar by address; neither signer nor writable.
 */
export function expectedMetaListData(): Uint8Array {
  const d = new Uint8Array(86);
  // TLV type: the transfer-hook Execute discriminator, sha256("spl-transfer-hook-interface:execute")[..8].
  d.set([105, 37, 101, 197, 75, 251, 102, 26], 0);
  new DataView(d.buffer).setUint32(8, 74, true); // value length: count + two 35-byte entries
  new DataView(d.buffer).setUint32(12, 2, true); // two entries
  d[16] = 1; // entry 1, discriminator 1: PDA of the hook program
  d.set([1, 6, ...new TextEncoder().encode("policy"), 3, 1], 17); // Literal "policy", AccountKey index 1 (mint); is_signer, is_writable = 0
  d[51] = 0; // entry 2, discriminator 0: a fixed address
  d.set(KNOWN_ACCOUNTS.sysvarInstructions.toBytes(), 52); // the instructions sysvar; is_signer, is_writable = 0
  return d;
}

const EXPECTED_EXTENSIONS = [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.TransferHook];

class Checks {
  readonly list: VerificationCheck[] = [];
  add(id: string, label: string, status: CheckStatus, detail: string): void {
    this.list.push({ id, label, status, detail });
  }
  /** Run a check; a throw becomes a failed check instead of aborting the report. */
  run(id: string, label: string, f: () => { status: CheckStatus; detail: string }): void {
    try {
      const r = f();
      this.add(id, label, r.status, r.detail);
    } catch (e) {
      this.add(id, label, "fail", `Could not verify: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  get overall(): CheckStatus {
    if (this.list.some((c) => c.status === "fail")) return "fail";
    if (this.list.some((c) => c.status === "warn")) return "warn";
    return "pass";
  }
}

/**
 * A per-wallet cap that needs more than this many full-cap wallets to fill
 * the batch (a wallet cap below 1% of the batch cap) is reported as a
 * warning: every `Commit` account costs rent that is never returned, so the
 * batch may stay near-empty and the open becomes a race. The program's own
 * floor is `batch_total_cap / 200` (about 200 wallets).
 */
const BATCH_WALLETS_WARN = 100n;

function fmtSol(lamports: bigint): string {
  const whole = lamports / POLICY.LAMPORTS_PER_SOL;
  const frac = lamports % POLICY.LAMPORTS_PER_SOL;
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

const pass = (detail: string): { status: CheckStatus; detail: string } => ({ status: "pass", detail });
const fail = (detail: string): { status: CheckStatus; detail: string } => ({ status: "fail", detail });
const warn = (detail: string): { status: CheckStatus; detail: string } => ({ status: "warn", detail });
const b58 = (k: PublicKey | null): string => (k === null ? "None" : k.toBase58());
const isoTs = (ts: bigint): string => {
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString().replace(".000Z", "Z") : `${ts}`;
};

function require_(cond: boolean, problems: string[], message: string): void {
  if (!cond) problems.push(message);
}

function readClock(acc: RawAccount | null): bigint | null {
  if (acc === null || acc.data.length < 40) return null;
  return new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigInt64(32, true);
}

function programInfo(program: RawAccount | null, pd: RawAccount | null): UpgradeableProgramInfo | null {
  if (program === null || pd === null) return null;
  return upgradeableProgramInfo(program, pd);
}

/** Static list of parties a Noised launch still trusts (docs/SECURITY_GUARANTEES.md). */
export const TRUSTED_PARTIES: readonly TrustedParty[] = [
  {
    name: "Meteora upgrade multisig (Squads v3, 4-of-7, no timelock)",
    address: TRUST_ANCHORS.meteoraMultisig,
    kind: "upgrade-multisig",
    note: `Upgrade authority (vault ${TRUST_ANCHORS.meteoraUpgradeAuthority.toBase58()}) of Meteora DBC and DAMM v2: can replace either program at any time, including every rule that relies on them. Recorded last deploys: DBC slot ${TRUST_ANCHORS.dbcLastDeploySlot}, DAMM v2 slot ${TRUST_ANCHORS.dammV2LastDeploySlot}; neither has a verified build.`,
  },
  ...TRUST_ANCHORS.meteoraAdmins.map(
    (address): TrustedParty => ({
      name: "Meteora DAMM v2 / DBC admin (single key)",
      address,
      kind: "admin",
      note: "Creates and removes operators. DAMM v2 operators can disable any pool (swaps stop; locked liquidity stays locked), raise a pool's static base fee up to 10%, change or disable its dynamic fee (the fee per trade can then reach the pool's 99% cap, which in practice blocks sells) and close configs (stalls graduation).",
    }),
  ),
  {
    name: "Meteora DBC operators",
    address: null,
    kind: "operator",
    note: "Manage token badges and claim protocol fees. In DBC 0.2.1 they cannot pause pools, change fees or withdraw reserves (until the multisig upgrades DBC).",
  },
  {
    name: "Token-2022 upgrade multisig (Squads v3, 4-of-6)",
    address: TRUST_ANCHORS.token2022Multisig,
    kind: "upgrade-multisig",
    note: `Upgrade authority (vault ${TRUST_ANCHORS.token2022UpgradeAuthority.toBase58()}) of Token-2022, which governs every Noised token: can replace it at any time. This path switched off confidential transfers in 2025.`,
  },
  {
    name: "Solana validators (feature gates)",
    address: null,
    kind: "validators",
    note: "Can change the runtime and core programs by feature activation (e.g. the ZK ElGamal kill switch, 2025-06-19 to 2026-06-04).",
  },
  {
    name: "Your RPC provider, this app's host and DNS, your wallet",
    address: null,
    kind: "infrastructure",
    note: "Can show false data or ask you to sign a harmful transaction. This report is only as honest as the RPC it read; cross-check with a second, independent RPC for large decisions.",
  },
];

export async function verifyLaunch(conn: Connection, mint: PublicKey, opts: VerifyOptions = {}): Promise<VerificationReport> {
  if (opts.nowSecs !== undefined) checkNowSecs(opts.nowSecs, "opts.nowSecs");
  const checks = new Checks();
  const certAddr = certificateAddress(mint);
  const programs = [PROGRAM_IDS.launchpad, PROGRAM_IDS.hook, PROGRAM_IDS.dbc, PROGRAM_IDS.dammV2, KNOWN_ACCOUNTS.token2022];
  const first = await getAccounts(conn, [
    mint,
    certAddr,
    hookPolicyAddress(mint),
    extraAccountMetaListAddress(mint),
    SYSVAR_CLOCK_PUBKEY,
    ...programs,
    ...programs.map(programDataAddress),
  ]);
  const [mintAcc, certAcc, policyAcc, metaListAcc, clockAcc] = first;
  const programAccs = first.slice(5, 5 + programs.length);
  const programDataAccs = first.slice(5 + programs.length);
  // The RPC's clock is untrusted data like the rest: one that is not plausible unix seconds is reported (the RPC
  // is broken or dishonest) and this device's clock is used instead, never blamed on the caller.
  const rpcClock = opts.nowSecs === undefined ? readClock(clockAcc ?? null) : null;
  const clockUsable = rpcClock !== null && plausibleUnixSecs(rpcClock);
  const nowSecs = opts.nowSecs ?? (clockUsable ? rpcClock : null) ?? unixNowSecs();
  if (rpcClock !== null && !clockUsable) {
    checks.add(
      "rpc.clock",
      "The RPC's clock",
      "warn",
      `The RPC returned a cluster clock (Clock sysvar) of ${rpcClock}, which is not plausible unix seconds: this RPC is broken or dishonest. This report used this device's clock instead; cross-check with another RPC.`,
    );
  }

  const infos = new Map<string, UpgradeableProgramInfo | Error | null>();
  programs.forEach((p, i) => {
    try {
      infos.set(p.toBase58(), programInfo(programAccs[i] ?? null, programDataAccs[i] ?? null));
    } catch (e) {
      infos.set(p.toBase58(), e instanceof Error ? e : new Error(String(e)));
    }
  });
  const trustedParties = await trustedPartiesLive(conn, infos, opts.listOperators ?? true);

  // ------------------------------------------------------- certificate ---
  let cert: CertificateAccount | null = null;
  if (certAcc === null || certAcc === undefined || certAcc.data.length === 0 || !certAcc.owner.equals(PROGRAM_IDS.launchpad)) {
    checks.add(
      "certificate.exists",
      "Noised launch certificate",
      "fail",
      `No launchpad-owned certificate at ${certAddr.toBase58()}. This mint was not launched by Noised, so none of Noised's guarantees apply to it.`,
    );
    return { mint, overall: "fail", phase: null, checks: checks.list, trustedParties, certificate: null, pqOrigin: null, metadata: null, rules: null };
  }
  try {
    cert = decodeCertificate(certAddr, certAcc.data);
  } catch (e) {
    checks.add("certificate.exists", "Noised launch certificate", "fail", `Certificate account cannot be decoded: ${e instanceof Error ? e.message : String(e)}`);
    return { mint, overall: "fail", phase: null, checks: checks.list, trustedParties, certificate: null, pqOrigin: null, metadata: null, rules: null };
  }
  const c = cert;
  checks.add("certificate.exists", "Noised launch certificate", "pass", `Certificate ${certAddr.toBase58()} written at ${isoTs(c.launchedAt)}; certificates are never modified or closed.`);
  checks.run("certificate.account", "Certificate belongs to this mint", () => {
    const problems: string[] = [];
    const [, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("certificate"), mint.toBytes()], PROGRAM_IDS.launchpad);
    require_(c.baseMint.equals(mint), problems, "base_mint differs from the mint");
    require_(c.bump === bump, problems, "non-canonical bump");
    // Certificate::VERSION 4 (creator rules); version 3 (on-chain metadata, no rules) is what launches before P1c hold.
    require_(c.version === CERTIFICATE.VERSION || c.version === CERTIFICATE.V3_VERSION, problems, `unknown certificate version ${c.version}`);
    require_(c.policyVersion === POLICY.SAFETY_POLICY_VERSION, problems, `policy version ${c.policyVersion}, expected ${POLICY.SAFETY_POLICY_VERSION}`);
    const v3 = c.version === CERTIFICATE.V3_VERSION ? " (written before launch rules existed: it records none)" : "";
    return problems.length === 0 ? pass(`Certificate v${c.version}${v3}, safety policy v${c.policyVersion}.`) : fail(problems.join("; "));
  });
  checks.run("certificate.checks", "All twelve launch-time checks recorded", () => {
    // Test the twelve required bits only (`(checks & 4095) === 4095`): a certificate with launch rules also carries RULES_BOUND (8,191).
    if (!certificateChecksComplete(c.checks)) {
      const missing = Object.entries(CERTIFICATE_CHECKS)
        .filter(([, bit]) => (c.checks & bit) === 0)
        .map(([name]) => name);
      return fail(`checks = ${c.checks}: ${missing.join(", ") || "a required check"} not recorded; every launch records all twelve (${CERTIFICATE_ALL_CHECKS}).`);
    }
    const base = `checks = ${c.checks}: the program verified every flag at launch, the post-quantum attestation and the on-chain metadata included.`;
    const bound =
      (c.checks & CERTIFICATE_RULES_BOUND) !== 0
        ? ` It also records RULES_BOUND (${CERTIFICATE_RULES_BOUND}): the program found the creator's signed launch rules in the Launch Guard.`
        : "";
    const unknown = c.checks - (c.checks & (CERTIFICATE_ALL_CHECKS | CERTIFICATE_RULES_BOUND));
    if (unknown !== 0) return warn(`${base}${bound} It also carries flags this verifier does not know (${unknown}): this verifier may be older than the program.`);
    return pass(`${base}${bound} Each one is re-checked live below.`);
  });

  // -------------------------------------------- launch, config and pool ---
  // The identity account is named by the certificate's pq_identity (an all-zero id has no account; pq.origin reports it).
  let identityAddr: PublicKey = PublicKey.default;
  try {
    identityAddr = identityAddressFromId(c.pqIdentity);
  } catch {
    identityAddr = PublicKey.default;
  }
  // The creator rules record the certificate names (none for the zero hash, and on a version-3 certificate).
  const certRulesAddr = isAllZero(c.rulesHash) ? null : launchRulesAddress(c.launch, c.rulesHash);
  const second = await getAccounts(conn, [c.launch, c.dbcConfig, c.pool, attestationAddress(c.launch), identityAddr, c.metadata, ...(certRulesAddr === null ? [] : [certRulesAddr])]);
  const [launchAcc, configAcc, poolAcc, attestationAcc, identityAcc, tokenMetaAcc] = second;
  const certRulesAcc: RawAccount | null = certRulesAddr === null ? null : (second[6] ?? null);
  let l: LaunchAccount | null = null;
  let launchError: string | null = null;
  if (launchAcc === null || launchAcc === undefined || !launchAcc.owner.equals(PROGRAM_IDS.launchpad)) {
    launchError = `No launchpad-owned Launch account at ${c.launch.toBase58()}.`;
  } else {
    try {
      l = decodeLaunch(c.launch, launchAcc.data);
    } catch (e) {
      launchError = `Launch account cannot be decoded: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const launchState: LaunchAccount | null = l;
  checks.run("launch.account", "Launch account matches the certificate", () => {
    if (launchState === null) return fail(launchError ?? "Launch account missing.");
    const lv = launchState;
    const problems: string[] = [];
    const pdas = launchPdasFromLaunch(lv.publicKey);
    require_(launchAddress(lv.creator, lv.launchSeed).equals(lv.publicKey), problems, "launch address does not derive from its creator and seed");
    require_(pdas.launchAuthority.equals(lv.launchAuthority) && pdas.batchAuthority.equals(lv.batchAuthority), problems, "authority PDAs do not derive from the launch");
    require_(pdas.dbcConfig.equals(lv.dbcConfig) && lv.dbcConfig.equals(c.dbcConfig), problems, "DBC config is not the launch's PDA");
    require_(lv.baseMint.equals(mint) && lv.pool.equals(c.pool), problems, "mint or pool differs");
    require_(lv.status === "live", problems, "launch is not live");
    require_(bytesEqual(lv.paramsHash, c.paramsHash), problems, "params_hash differs");
    require_(lv.creator.equals(c.creator), problems, "creator differs");
    require_(lv.tokenDecimal === c.tokenDecimal && lv.migrationQuoteThreshold === c.migrationQuoteThreshold && lv.migrationFeeOption === c.migrationFeeOption, problems, "decimals, threshold or fee tier differ");
    require_(lv.platformFeeBps === c.platformFeeBps, problems, "platform fee differs");
    require_(
      lv.recipients.length === c.recipients.length && lv.recipients.every((r, i) => r.wallet.equals(c.recipients[i]!.wallet) && r.bps === c.recipients[i]!.bps),
      problems,
      "fee recipients differ",
    );
    require_(lv.p2pLocked === c.p2pLocked, problems, "p2p lock differs");
    require_(lv.launchTs === c.launchedAt && lv.executeEndTs === c.executeEndTs && lv.guardEndTs === c.guardEndTs && c.snipeShieldEndTs === c.executeEndTs, problems, "timeline differs");
    return problems.length === 0
      ? pass(`Launch ${lv.publicKey.toBase58()}: PDAs, parameters hash, fee routing and timeline equal the certificate.`)
      : fail(problems.join("; "));
  });

  if (launchState !== null) {
    const lv: LaunchAccount = launchState;
    checks.run("launch.policy", "Stored parameters are within the safety policy", () => {
      const problems: string[] = [];
      require_(lv.openDelaySecs >= POLICY.MIN_OPEN_DELAY && lv.openDelaySecs <= POLICY.MAX_OPEN_DELAY, problems, "open delay out of bounds");
      require_(lv.guardSecs >= lv.openDelaySecs + POLICY.EXECUTION_GRACE_SECS && lv.guardSecs <= POLICY.MAX_GUARD_SECS, problems, "guard out of bounds");
      require_(lv.commitEndTs === lv.launchTs + BigInt(lv.openDelaySecs), problems, "commit window end inconsistent");
      require_(lv.executeEndTs === lv.commitEndTs + BigInt(POLICY.EXECUTION_GRACE_SECS), problems, "execution window end inconsistent");
      require_(lv.guardEndTs === lv.launchTs + BigInt(lv.guardSecs), problems, "guard end inconsistent");
      require_(lv.maxWalletBps === 0 || (lv.maxWalletBps >= POLICY.MIN_MAX_WALLET_BPS && lv.maxWalletBps <= POLICY.BPS_DENOMINATOR), problems, "max wallet out of bounds");
      require_(lv.maxBuyBps <= POLICY.BPS_DENOMINATOR, problems, "max buy out of bounds");
      require_(lv.platformFeeBps <= POLICY.MAX_PLATFORM_FEE_BPS, problems, "platform fee above 50%");
      // policy::validate_batch_caps (stored resolved: 0 became the threshold).
      require_(
        lv.batchTotalCap > 0n && lv.batchTotalCap >= lv.migrationQuoteThreshold / POLICY.MIN_BATCH_TOTAL_CAP_DIVISOR && lv.batchTotalCap <= lv.migrationQuoteThreshold,
        problems,
        "batch cap outside threshold/10..=threshold",
      );
      require_(lv.batchWalletCap === 0n || lv.batchWalletCap >= lv.batchTotalCap / POLICY.MIN_BATCH_WALLET_CAP_DIVISOR, problems, "per-wallet batch cap below 1/200 of the batch cap");
      const active = activeRecipients(lv);
      require_(lv.recipientCount >= 1 && lv.recipientCount <= POLICY.MAX_RECIPIENTS, problems, "recipient count out of bounds");
      require_(active.reduce((sum, r) => sum + r.bps, 0) === POLICY.BPS_DENOMINATOR, problems, "recipient shares do not total 100%");
      require_(active.every((r) => !r.wallet.equals(PublicKey.default) && r.bps > 0), problems, "a recipient slot is empty");
      require_(lv.recipients.slice(lv.recipientCount).every((r) => r.wallet.equals(PublicKey.default) && r.bps === 0), problems, "unused recipient slots are not empty");
      const forbidden = [lv.launchAuthority, lv.batchAuthority];
      require_(active.every((r) => !forbidden.some((f) => f.equals(r.wallet))), problems, "a recipient is one of the launch's own PDAs");
      require_(c.maxWallet === (capFromBps(c.initialSupply, lv.maxWalletBps) ?? -1n), problems, "max wallet does not equal supply x bps");
      require_(c.maxBuy === (capFromBps(c.initialSupply, lv.maxBuyBps) ?? -1n), problems, "max buy does not equal supply x bps");
      const routing = active.map((r) => `${r.wallet.toBase58()} ${r.bps / 100}%`).join(", ");
      return problems.length === 0
        ? pass(`Fees: ${lv.platformFeeBps / 100}% platform (treasury ${lv.treasury.toBase58()}), the rest to ${routing}; no instruction can change this.`)
        : fail(problems.join("; "));
    });
    checks.run("batch.cap", "Fair-open batch size (total and per-wallet caps)", () => {
      const threshold = lv.migrationQuoteThreshold;
      const shareBps = threshold === 0n ? 0 : Number((lv.batchTotalCap * BigInt(POLICY.BPS_DENOMINATOR)) / threshold);
      const what = `The batch buys at most ${fmtSol(lv.batchTotalCap)} SOL, ${shareBps / 100}% of the ${fmtSol(threshold)} SOL migration threshold`;
      const problems: string[] = [];
      // The policy floor, exactly (`threshold / 10`, integer division): below it most of the curve is left to buyers after the batch.
      if (lv.batchTotalCap < threshold / POLICY.MIN_BATCH_TOTAL_CAP_DIVISOR) {
        problems.push(`below ${100 / Number(POLICY.MIN_BATCH_TOTAL_CAP_DIVISOR)}% of the threshold, most of the curve is left to buyers after the batch`);
      }
      let perWallet: string;
      if (lv.batchWalletCap === 0n) perWallet = "no per-wallet cap";
      else {
        // Wallets needed to fill the batch at the per-wallet cap (rounded up).
        const wallets = (lv.batchTotalCap + lv.batchWalletCap - 1n) / lv.batchWalletCap;
        perWallet = `each wallet commits at most ${fmtSol(lv.batchWalletCap)} SOL, so filling the batch takes at least ${wallets} wallet${wallets === 1n ? "" : "s"}`;
        if (wallets > BATCH_WALLETS_WARN) {
          problems.push(
            `the per-wallet cap of ${fmtSol(lv.batchWalletCap)} SOL needs ${wallets} wallets to fill the batch (more than ${BATCH_WALLETS_WARN}); every commit account costs rent that is never returned, so the batch can stay near-empty and the open becomes a race`,
          );
        }
      }
      return problems.length > 0
        ? warn(`${what}; ${perWallet}. The fair open may be ineffective: ${problems.join("; ")}.`)
        : pass(`${what}; ${perWallet}. Commits above the cap are filled pro rata and the rest refunded at claim.`);
    });
    checks.run("batch.accounting", "Fair-open batch accounting", () => {
      const problems: string[] = [];
      const spendable = lv.totalCommitted < lv.batchTotalCap ? lv.totalCommitted : lv.batchTotalCap;
      require_(lv.quoteSpent <= spendable, problems, "quote spent above min(total committed, batch cap)");
      require_(lv.tokensClaimed <= lv.tokensOut, problems, "tokens claimed above tokens bought");
      const refundable = lv.executed ? lv.totalCommitted - lv.quoteSpent : lv.totalCommitted;
      require_(lv.quoteRefunded <= refundable, problems, "refunds above the refundable amount");
      if (problems.length > 0) return fail(problems.join("; "));
      const fill = expectedBatchFill(lv);
      const share = `${fill.fillBps / 100}% of each commit`;
      if (lv.executed) {
        return pass(
          `Batch bought ${lv.tokensOut} base units for ${lv.quoteSpent} of ${lv.totalCommitted} lamports committed (${share} spent, the rest refunded at claim); ${lv.tokensClaimed} units and ${lv.quoteRefunded} lamports paid out so far.`,
        );
      }
      if (nowSecs >= lv.executeEndTs) {
        return pass(lv.totalCommitted === 0n ? "Nobody committed to the batch." : "The batch was not executed in its window: every commit is refundable in full.");
      }
      return pass(
        fill.oversubscribed
          ? `Batch pending and oversubscribed: ${lv.totalCommitted} lamports committed for a cap of ${lv.batchTotalCap}; at most ${share} will be spent, the rest refunded at claim.`
          : `Batch pending: ${lv.totalCommitted} lamports committed (cap ${lv.batchTotalCap}).`,
      );
    });
  }

  // ----------------------------------------------------------------- mint ---
  let parsed: ParsedMint | null = null;
  let mintError: string | null = null;
  if (mintAcc === null || mintAcc === undefined) mintError = "The mint account does not exist.";
  else if (!mintAcc.owner.equals(KNOWN_ACCOUNTS.token2022)) mintError = `Owned by ${mintAcc.owner.toBase58()}, not Token-2022.`;
  else {
    try {
      parsed = parseMint(mintAcc.owner, mintAcc.data);
    } catch (e) {
      mintError = `Mint data does not parse the way Token-2022 parses it: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const pm: ParsedMint | null = parsed;
  checks.add(
    "mint.program",
    "Mint is a Token-2022 mint",
    pm === null ? "fail" : "pass",
    pm === null ? (mintError ?? "Mint unreadable.") : `Owner ${KNOWN_ACCOUNTS.token2022.toBase58()}; ${pm.decimals} decimals.`,
  );
  let pool: DbcPoolState | null = null;
  try {
    if (poolAcc !== null && poolAcc !== undefined && poolAcc.owner.equals(PROGRAM_IDS.dbc)) pool = decodeDbcTransferHookPool(poolAcc.data).poolState;
  } catch {
    pool = null; // reported by dbc.pool
  }
  const poolState: DbcPoolState | null = pool;
  const status = poolState !== null && launchState !== null ? curveStatus(poolState, launchState.migrationQuoteThreshold) : null;
  const graduated = status !== null && (status.curveComplete || status.migrated);

  if (pm !== null) {
    const m: ParsedMint = pm;
    checks.run("mint.mintAuthority", "Mint authority is None (live)", () =>
      m.mintAuthority === null ? pass("Nobody can mint more tokens.") : fail(`Mint authority is ${b58(m.mintAuthority)}.`),
    );
    checks.run("mint.freezeAuthority", "Freeze authority is None (live)", () =>
      m.freezeAuthority === null ? pass("Nobody can freeze holders.") : fail(`Freeze authority is ${b58(m.freezeAuthority)}.`),
    );
    checks.run("mint.extensions", "Extension set is exactly MetadataPointer + TokenMetadata + TransferHook (live)", () => {
      // @solana/spl-token's walk does not stop at padding, so give it exactly the used TLV region.
      const viaSpl = getExtensionTypes(Buffer.from(m.tlvData.subarray(0, m.tlvUsedLength))) as number[];
      const splTypes = viaSpl.slice().sort((a, b) => a - b);
      const strict = m.extensions.map((x) => x.type).sort((a, b) => a - b);
      if (splTypes.join() !== strict.join()) return fail(`Inconsistent extension data: getExtensionTypes [${splTypes.join(", ")}] vs strict parse [${strict.join(", ")}].`);
      const want = [...EXPECTED_EXTENSIONS].sort((a, b) => a - b);
      return strict.join() === want.join()
        ? pass("MetadataPointer, TokenMetadata, TransferHook. No permanent delegate, fee, pause, default state, close authority or confidential extension.")
        : fail(`Extensions: ${strict.map(extensionName).join(", ") || "none"}.`);
    });
    checks.run("mint.metadataPointer", "Metadata pointer authority is None and points at the mint (live)", () => {
      const p = metadataPointerOf(m);
      if (p === null) return fail("No MetadataPointer extension.");
      return p.authority === null && p.metadataAddress !== null && p.metadataAddress.equals(mint)
        ? pass("Pointer authority None; metadata lives in the mint.")
        : fail(`Pointer authority ${b58(p.authority)}, address ${b58(p.metadataAddress)}.`);
    });
    checks.run("mint.metadata", "Metadata update authority is None (live)", () => {
      const d = m.extensions.find((x) => x.type === ExtensionType.TokenMetadata)?.data;
      if (d === undefined) return fail("No TokenMetadata extension.");
      if (d.length < 64) return fail("TokenMetadata is truncated.");
      if (!isAllZero(d.subarray(0, 32))) return fail(`Update authority is ${new PublicKey(d.subarray(0, 32)).toBase58()}.`);
      if (!bytesEqual(d.subarray(32, 64), mint.toBytes())) return fail("TokenMetadata names another mint.");
      return pass("Name, symbol and URI can never change.");
    });
    checks.run("mint.supply", "Decimals and supply match the certificate", () => {
      if (m.decimals !== c.tokenDecimal) return fail(`${m.decimals} decimals, certificate says ${c.tokenDecimal}.`);
      if (m.supply > c.initialSupply) return fail(`Supply ${m.supply} is above the initial supply ${c.initialSupply}.`);
      return pass(`Supply ${m.supply} of ${c.initialSupply} initially (burns only lower it).`);
    });
    checks.run("mint.transferHook", graduated ? "Transfer hook revoked at graduation (live)" : "Transfer hook is the Launch Guard (live)", () => {
      const h = transferHookOf(m);
      if (h === null) return fail("No TransferHook extension.");
      if (status === null) return fail("Cannot tell the curve state (DBC pool unreadable).");
      if (graduated) {
        return h.programId === null && h.authority === null
          ? pass("DBC set the hook program and authority to None when the curve completed: the token is a plain Token-2022 token now.")
          : fail(`The curve completed but the hook is program ${b58(h.programId)}, authority ${b58(h.authority)}.`);
      }
      if (h.programId === null) return fail("The hook was revoked although the curve has not completed.");
      return h.programId.equals(PROGRAM_IDS.hook) && h.authority !== null && h.authority.equals(KNOWN_ACCOUNTS.dbcPoolAuthority)
        ? pass(`Hook program ${PROGRAM_IDS.hook.toBase58()}; authority ${KNOWN_ACCOUNTS.dbcPoolAuthority.toBase58()} (DBC pool authority, used only to revoke it at curve completion).`)
        : fail(`Hook program ${b58(h.programId)}, authority ${b58(h.authority)}.`);
    });
  }

  // ------------------------------------------------- post-quantum origin ---
  let onChainMeta: OnChainMetadata | null = null;
  if (pm !== null) {
    try {
      const d = pm.extensions.find((x) => x.type === ExtensionType.TokenMetadata)?.data;
      if (d !== undefined) onChainMeta = tokenMetadataFields(d);
    } catch {
      onChainMeta = null; // reported by pq.origin (message not rebuildable)
    }
  }
  // The rules record the attestation names: the certificate's, read above, unless the two disagree (launch.rules
  // reports that); then the attested one is read too, so the origin shows what the identity signed.
  let attestedRulesAcc: RawAccount | null = certRulesAcc;
  try {
    if (attestationAcc !== null && attestationAcc !== undefined && attestationAcc.owner.equals(PROGRAM_IDS.launchpad) && attestationAcc.data.length > 0) {
      const a = decodeAttestation(attestationAddress(c.launch), attestationAcc.data);
      if (a.attested && !bytesEqual(a.rulesHash, c.rulesHash)) {
        attestedRulesAcc = isAllZero(a.rulesHash) ? null : ((await getAccounts(conn, [launchRulesAddress(c.launch, a.rulesHash)]))[0] ?? null);
      }
    }
  } catch {
    // Reported by pq.origin.
  }
  let pq: PqOriginResult;
  try {
    pq = checkPqOrigin({
      certificate: c,
      launch: launchState,
      attestation: attestationAcc ?? null,
      identity: identityAcc ?? null,
      tokenMeta: tokenMetaAcc ?? null,
      metadata: onChainMeta,
      rules: attestedRulesAcc,
    });
  } catch (e) {
    pq = { origin: null, problems: [`could not verify (${e instanceof Error ? e.message : String(e)})`], message: null, record: null, rulesRecord: null, attestation: null };
  }
  const pqOrigin: PqOrigin | null = pq.origin;
  const pqLabel = "Post-quantum origin: the creator's identity signed this launch (re-verified)";
  if (pqOrigin !== null && pq.problems.length === 0) {
    const o = pqOrigin;
    const signedRules = o.rules.address === null ? "It signed no launch rules." : `It also signed the launch rules with hash ${o.rules.hash} (record ${o.rules.address.toBase58()}).`;
    checks.add(
      "pq.origin",
      pqLabel,
      "pass",
      `Post-quantum identity ${toHex(o.identityId)} signed this launch, its parameters, its creator and its on-chain metadata record (name, symbol, description, icon) with one-time leaf ${o.leaf} (attestation ${o.attestation.toBase58()}, slot ${o.attestationSlot}). ${signedRules} The LMS signature (hash-based, RFC 8554: a quantum computer cannot forge it) was re-verified here against the identity's public key, over the message rebuilt from on-chain data. It allowed the launch only between ${isoTs(o.window.notBefore)} and ${isoTs(o.window.notAfter)}; it launched at ${isoTs(c.launchedAt)}.`,
    );
  } else {
    checks.add("pq.origin", pqLabel, "fail", `Not PQ-attested: ${pq.problems.join("; ")}.`);
  }

  // ------------------------------------------------- on-chain metadata ---
  const record = pq.record;
  let document: ParsedMetadataDoc | null = null;
  const metadataProblems: string[] = [];
  checks.run("metadata.onchain", "Metadata stored on-chain", () => {
    const problems: string[] = [];
    require_((c.checks & CERTIFICATE_CHECKS.METADATA_ONCHAIN) !== 0, problems, "the certificate does not record the metadata check (METADATA_ONCHAIN)");
    if (record === null) problems.push(`no valid metadata record at ${c.metadata.toBase58()}, the address the certificate names`);
    else {
      require_(pqOrigin !== null && record.publicKey.equals(pqOrigin.tokenMeta), problems, "the certificate's record is not the one the attestation signed");
      require_(record.launch.equals(c.launch), problems, "the record belongs to another launch");
    }
    metadataProblems.push(...problems);
    if (problems.length > 0) return fail(problems.join("; "));
    const r = record!;
    const where = `Name, symbol and document are stored in ${r.publicKey.toBase58()}, at the address of their own hash, which the creator's post-quantum identity signed; the record can never change.`;
    if (r.flags === METADATA.FLAG_EXTERNAL_URI) {
      return warn(`${where} The mint's link also points to ${r.uri}, a page the creator chose: what it serves can change and is not checked here.`);
    }
    return pass(r.flags === METADATA.FLAG_INLINE_URI ? `${where} The mint's link carries the same document inline.` : `${where} The mint's link is empty: nothing is loaded from elsewhere.`);
  });
  if (record !== null) {
    try {
      document = parseMetadataDoc(record.doc, { name: record.record.name, symbol: record.record.symbol });
    } catch {
      document = null;
    }
    checks.run("metadata.match", "Name and symbol match the record", () => {
      const problems: string[] = [];
      if (onChainMeta === null) problems.push("the mint's metadata is unreadable");
      else {
        require_(bytesEqual(onChainMeta.name, record.record.name), problems, "the mint's name is not the record's");
        require_(bytesEqual(onChainMeta.symbol, record.record.symbol), problems, "the mint's symbol is not the record's");
        require_(bytesEqual(onChainMeta.uri, tokenUriBytes(record.record)), problems, "the mint's link is not the one derived from the record");
        require_(onChainMeta.additional.length === 4 && isAllZero(onChainMeta.additional), problems, "the mint carries extra metadata fields");
      }
      if (document !== null) {
        if (document.name !== null && document.name !== record.name) problems.push(`the document's name "${document.name}" is not the record's`);
        if (document.symbol !== null && document.symbol !== record.symbol) problems.push(`the document's symbol "${document.symbol}" is not the record's`);
      }
      metadataProblems.push(...problems);
      return problems.length === 0
        ? pass(`The token is "${record.name}" (${record.symbol}) in the mint, in the record and in its document.`)
        : fail(problems.join("; "));
    });
    checks.run("metadata.icon", "Icon is an inline PNG", () => {
      const d = document;
      if (d === null) return warn("The record's document could not be read.");
      if (d.empty) return pass("The record has no document: no icon or description, and nothing is loaded from elsewhere.");
      if (!d.ok) return warn(`The record's document is not shown: ${d.problems.join("; ")}.`);
      if (d.icon === null) return pass("No icon: the record's document has none, and nothing is loaded from elsewhere.");
      return pass(`The icon is a ${d.icon.width}x${d.icon.height} PNG stored inside the record (${d.icon.png.length} bytes); it is never loaded from a link.`);
    });
  }
  const metadata: VerifiedMetadata = {
    address: c.metadata,
    record,
    document,
    verified: record !== null && pqOrigin !== null && pq.problems.length === 0 && metadataProblems.length === 0,
  };

  // ------------------------------------------------------------ DBC config ---
  let decodedCfg: DbcConfigWithTransferHook | null = null;
  let cfgError: string | null = null;
  if (configAcc === null || configAcc === undefined || !configAcc.owner.equals(PROGRAM_IDS.dbc)) cfgError = `No DBC-owned config at ${c.dbcConfig.toBase58()}.`;
  else if (configAcc.data.length < idlCodecs().dbc.accountSize("ConfigWithTransferHook")) cfgError = "Config account too short.";
  else {
    try {
      decodedCfg = decodeDbcConfigWithTransferHook(configAcc.data);
    } catch (e) {
      cfgError = `Config cannot be decoded as ConfigWithTransferHook: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const cfg: DbcConfigWithTransferHook | null = decodedCfg;
  checks.run("dbc.config", "DBC config holds the fixed safe values", () => {
    if (cfg === null) return fail(cfgError ?? "Config unreadable.");
    const kk = cfg.config;
    const problems: string[] = [];
    const la = launchState === null ? null : launchState.launchAuthority;
    require_(cfg.transferHookProgram.equals(PROGRAM_IDS.hook), problems, `transfer hook program ${cfg.transferHookProgram.toBase58()}`);
    require_(la !== null && kk.feeClaimer.equals(la) && kk.leftoverReceiver.equals(la), problems, "fee claimer / leftover receiver is not the launch authority");
    require_(kk.tokenType === DBC.TOKEN_TYPE_TOKEN_2022, problems, "token type is not Token-2022");
    require_(kk.tokenUpdateAuthority === DBC.TOKEN_UPDATE_AUTHORITY_IMMUTABLE, problems, `token update authority option ${kk.tokenUpdateAuthority} (must be 1, immutable)`);
    require_(kk.migrationOption === DBC.MIGRATION_OPTION_DAMM_V2, problems, "migration target is not DAMM v2");
    require_(kk.collectFeeMode === DBC.COLLECT_FEE_MODE_QUOTE, problems, "fees not collected in quote");
    require_(kk.activationType === DBC.ACTIVATION_TYPE_TIMESTAMP, problems, "activation type is not timestamp");
    require_(kk.creatorTradingFeePercentage === 0, problems, "creator trading fee share is not 0");
    require_(kk.fixedTokenSupplyFlag === 0, problems, "fixed token supply");
    require_(kk.poolCreationFee === 0n, problems, "pool creation fee");
    require_(kk.enableFirstSwapWithMinFee === 0, problems, "first-swap fee exemption enabled");
    require_(kk.tokenDecimal === c.tokenDecimal && kk.migrationQuoteThreshold === c.migrationQuoteThreshold && kk.migrationFeeOption === c.migrationFeeOption, problems, "decimals, threshold or fee tier differ from the certificate");
    return problems.length === 0
      ? pass(`Config ${c.dbcConfig.toBase58()}: Token-2022 with the Launch Guard hook, immutable metadata, DAMM v2 migration, quote-only fees to the launch authority PDA, no first-swap privilege.`)
      : fail(problems.join("; "));
  });
  const k = cfg === null ? null : cfg.config;
  if (k !== null) {
    checks.run("dbc.lpLocked", "100% of graduated liquidity is permanently locked (config)", () =>
      k.partnerPermanentLockedLiquidityPercentage === 100 &&
      k.partnerLiquidityPercentage === 0 &&
      k.creatorLiquidityPercentage === 0 &&
      k.creatorPermanentLockedLiquidityPercentage === 0 &&
      k.partnerLiquidityVestingInfo.isInitialized === 0 &&
      k.creatorLiquidityVestingInfo.isInitialized === 0
        ? pass("Partner (launch authority) 100% permanently locked; no withdrawable or vesting LP for anyone.")
        : fail(
            `partner locked ${k.partnerPermanentLockedLiquidityPercentage}%, partner ${k.partnerLiquidityPercentage}%, creator ${k.creatorLiquidityPercentage}%, creator locked ${k.creatorPermanentLockedLiquidityPercentage}%, vesting ${k.partnerLiquidityVestingInfo.isInitialized}/${k.creatorLiquidityVestingInfo.isInitialized}.`,
          ),
    );
    checks.run("dbc.noMigrationFee", "No creator or partner migration fee (config)", () =>
      k.migrationFeePercentage === 0 && k.creatorMigrationFeePercentage === 0
        ? pass("Creator and partner migration fees are 0%: the raise goes into the pool except Meteora's fixed 0.2% protocol migration fee, which no config can change.")
        : fail(`Migration fee ${k.migrationFeePercentage}% (creator ${k.creatorMigrationFeePercentage}%).`),
    );
    checks.run("dbc.noCreatorAllocation", "No creator allocation or vesting (config)", () => {
      const v = k.lockedVestingConfig;
      return v.amountPerPeriod === 0n && v.cliffDurationFromMigrationTime === 0n && v.frequency === 0n && v.numberOfPeriod === 0n && v.cliffUnlockAmount === 0n
        ? pass("Locked vesting is all zero: the creator buys in the batch like everyone else.")
        : fail("Locked vesting is configured.");
    });
    checks.run("dbc.quoteWsol", "Quote token is wSOL (config)", () => (k.quoteMint.equals(WSOL_MINT) ? pass("wSOL: no freeze or mint authority.") : fail(`Quote mint ${k.quoteMint.toBase58()}.`)));
    checks.run("dbc.fees", "Trading fee after the fair-open batch is at most 10%", () => {
      const bf = k.poolFees.baseFee;
      const base = { cliffFeeNumerator: bf.cliffFeeNumerator, firstFactor: bf.firstFactor, secondFactor: bf.secondFactor, thirdFactor: bf.thirdFactor, baseFeeMode: bf.baseFeeMode };
      if (bf.baseFeeMode !== DBC.BASE_FEE_MODE_LINEAR && bf.baseFeeMode !== DBC.BASE_FEE_MODE_EXPONENTIAL) return fail(`Base fee mode ${bf.baseFeeMode} is not a fee scheduler.`);
      const floor = minBaseFeeNumerator(base);
      if (floor === null) return fail("The fee schedule is invalid.");
      const d = k.poolFees.dynamicFee;
      const dyn = d.initialized === 0 ? 0n : maxVariableFeeNumerator(d);
      if (dyn === null) return fail("The dynamic fee overflows.");
      const duration = feeScheduleDuration(base);
      const problems: string[] = [];
      require_(withinFeeCeiling(floor, dyn), problems, `floor ${feeNumeratorToBps(floor)} bps + dynamic up to ${feeNumeratorToBps(dyn)} bps exceeds ${POLICY.MAX_TRADING_FEE_BPS} bps`);
      require_(launchState === null || duration <= BigInt(launchState.openDelaySecs), problems, `the fee schedule (${duration}s) outlasts the commit window`);
      return problems.length === 0
        ? pass(`Cliff ${feeNumeratorToBps(bf.cliffFeeNumerator)} bps decaying to ${feeNumeratorToBps(floor)} bps within ${duration}s (before the batch); dynamic fee adds at most ${feeNumeratorToBps(dyn)} bps.`)
        : fail(problems.join("; "));
    });
  }

  // -------------------------------------------------------------- DBC pool ---
  checks.run("dbc.pool", "DBC pool belongs to this launch", () => {
    if (poolAcc === null || poolAcc === undefined || !poolAcc.owner.equals(PROGRAM_IDS.dbc)) return fail(`No DBC-owned pool at ${c.pool.toBase58()}.`);
    if (poolState === null) return fail("The pool account cannot be decoded as a transfer-hook pool.");
    const p: DbcPoolState = poolState;
    const problems: string[] = [];
    require_(dbcPoolAddress(c.dbcConfig, mint, WSOL_MINT).equals(c.pool), problems, "pool is not the DBC PDA of (config, mint, wSOL)");
    require_(p.config.equals(c.dbcConfig), problems, "pool config differs");
    require_(launchState !== null && p.creator.equals(launchState.launchAuthority), problems, "pool creator is not the launch authority");
    require_(p.baseMint.equals(mint), problems, "pool base mint differs");
    require_(p.baseVault.equals(dbcTokenVaultAddress(mint, c.pool)) && p.quoteVault.equals(dbcTokenVaultAddress(WSOL_MINT, c.pool)), problems, "pool vaults are not the DBC PDAs");
    return problems.length === 0 ? pass(`Pool ${c.pool.toBase58()}: ${p.quoteReserve} lamports raised of ${c.migrationQuoteThreshold}.`) : fail(problems.join("; "));
  });

  // A pending batch must be the pool's first swap (`execute_batch` refuses
  // otherwise with PoolAlreadyTraded); reported only while it is pending.
  if (launchState !== null && !launchState.executed && poolState !== null) {
    const lv = launchState;
    const p = poolState;
    checks.run("batch.firstSwap", "The fair-open batch is still the pool's first trade", () => {
      if (p.hasSwap === 0) return pass("Nobody has traded on the pool yet: the batch buys at the opening price.");
      return warn(
        nowSecs < lv.executeEndTs
          ? "The pool was traded before the batch, which the Launch Guard should have prevented: execute_batch now fails (PoolAlreadyTraded) and every commit is refunded in full after the execution window."
          : "The pool was traded and the batch did not execute: every commit is refundable in full.",
      );
    });
  }

  // ------------------------------------------------------------------ hook ---
  let decodedPolicy: HookPolicyAccount | null = null;
  let policyError: string | null = null;
  if (policyAcc === null || policyAcc === undefined || !policyAcc.owner.equals(PROGRAM_IDS.hook)) policyError = `No hook-owned policy at ${hookPolicyAddress(mint).toBase58()}.`;
  else {
    try {
      decodedPolicy = decodeHookPolicy(hookPolicyAddress(mint), policyAcc.data);
    } catch (e) {
      policyError = `The policy cannot be decoded: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const policy: HookPolicyAccount | null = decodedPolicy;
  checks.run("hook.policy", "Launch Guard policy matches the certificate", () => {
    if (policy === null) return fail(policyError ?? "Policy unreadable.");
    const pol = policy;
    const problems: string[] = [];
    const lv = launchState;
    require_(pol.mint.equals(mint) && pol.pool.equals(c.pool), problems, "mint or pool differs");
    require_(pol.baseVault.equals(dbcTokenVaultAddress(mint, c.pool)), problems, "base vault is not the pool's");
    require_(pol.launchTs === c.launchedAt && pol.guardEndTs === c.guardEndTs, problems, "timeline differs");
    const shieldProblem = snipeShieldEndProblem(pol.snipeShieldEndTs, c, lv);
    if (shieldProblem !== null) problems.push(shieldProblem);
    require_(pol.maxWallet === c.maxWallet && pol.maxBuy === c.maxBuy && pol.p2pLocked === c.p2pLocked, problems, "caps or p2p lock differ");
    require_(
      lv !== null &&
        pol.exempt.length === 4 &&
        pol.exempt[0]!.equals(lv.batchAuthority) &&
        pol.exempt[1]!.equals(lv.launchAuthority) &&
        pol.exempt[2]!.equals(PublicKey.default) &&
        pol.exempt[3]!.equals(PublicKey.default),
      problems,
      "exempt owners are not exactly the batch and launch authorities",
    );
    const shield = pol.snipeShieldEndTs - pol.launchTs;
    const guard = pol.guardEndTs - pol.launchTs;
    require_(shield >= 0n && shield <= BigInt(HOOK_BOUNDS.MAX_SNIPE_SHIELD_SECS) && shield <= guard && guard <= BigInt(HOOK_BOUNDS.MAX_GUARD_SECS), problems, "timing outside the hook's hard bounds");
    require_(pol.maxWallet === 0n || pol.maxWallet >= c.initialSupply / HOOK_BOUNDS.MIN_MAX_WALLET_DIVISOR, problems, "max wallet below 0.1% of supply");
    require_(pol.maxBuy === 0n || pol.maxBuy >= c.initialSupply / HOOK_BOUNDS.MIN_MAX_BUY_DIVISOR, problems, "max buy below 0.01% of supply");
    if (problems.length > 0) return fail(problems.join("; "));
    const caps = [
      pol.maxWallet === 0n ? "max wallet off" : `max wallet ${pol.maxWallet}`,
      pol.maxBuy === 0n ? "max buy off" : `max buy ${pol.maxBuy}`,
      pol.p2pLocked ? "wallet-to-wallet paused" : "wallet-to-wallet allowed",
    ].join(", ");
    const shieldText =
      pol.snipeShieldEndTs === c.snipeShieldEndTs
        ? `No buys before ${isoTs(pol.snipeShieldEndTs)} except the batch buy inside the launchpad's execute_batch`
        : `The batch bought and execute_batch ended the snipe shield at ${isoTs(pol.snipeShieldEndTs)} (scheduled ${isoTs(c.snipeShieldEndTs)}); before that, no buys except the batch buy`;
    return pass(
      `${shieldText}; until ${isoTs(pol.guardEndTs)}: ${caps}. Only the batch and launch authorities are exempt from the caps (never from the snipe shield); sells are never blocked.`,
    );
  });
  checks.run("hook.metaList", "Hook account list is the canonical one", () => {
    if (metaListAcc === null || metaListAcc === undefined || !metaListAcc.owner.equals(PROGRAM_IDS.hook)) return fail(`No hook-owned ExtraAccountMetaList at ${extraAccountMetaListAddress(mint).toBase58()}.`);
    return bytesEqual(metaListAcc.data, expectedMetaListData())
      ? pass("Token-2022 passes exactly two extra accounts to the hook: the mint's policy PDA and the instructions sysvar (read to recognize the batch buy).")
      : fail(`Unexpected meta list contents (${toHex(metaListAcc.data).slice(0, 32)}…, ${metaListAcc.data.length} bytes).`);
  });

  // ---------------------------------------------------------- launch rules ---
  const rules = checkLaunchRules(checks, { c, launch: launchState, policy, policyError, attestation: pq.attestation, certRulesAddr, certRulesAcc });

  // ----------------------------------------------------------------- phase ---
  let phase: LaunchPhase | null = null;
  if (launchState !== null) {
    const lv = launchState;
    phase = launchPhase({ ...lv, market: status ?? undefined }, nowSecs);
    checks.add(
      "launch.phase",
      "Current phase",
      "pass",
      `${phase} at ${isoTs(nowSecs)} (commit until ${isoTs(lv.commitEndTs)}, batch execution until ${isoTs(lv.executeEndTs)}, guard until ${isoTs(lv.guardEndTs)}).`,
    );
  }

  // ------------------------------------------------------ after graduation ---
  if (status !== null && status.curveComplete && !status.migrated) {
    checks.add("damm.migration", "Graduation pending", "pass", "The curve completed; anyone can now call DBC's migration to DAMM v2 (permissionless).");
  }
  if (status !== null && status.migrated && launchState !== null) {
    await postMigrationChecks(conn, checks, launchState, c);
  }

  // -------------------------------------------------------------- programs ---
  programChecks(checks, infos);

  return { mint, overall: checks.overall, phase, checks: checks.list, trustedParties, certificate: cert, pqOrigin, metadata, rules };
}

interface RulesInputs {
  c: CertificateAccount;
  launch: LaunchAccount | null;
  /** The decoded Launch Guard policy (null: missing or undecodable, see `policyError`). */
  policy: HookPolicyAccount | null;
  policyError: string | null;
  /** The decoded attestation (null: none or undecodable). */
  attestation: PqOriginResult["attestation"];
  /** `["rules", launch, certificate.rulesHash]` (null: the certificate records no rules) and the account there. */
  certRulesAddr: PublicKey | null;
  certRulesAcc: RawAccount | null;
}

/**
 * The `launch.rules` check and `report.rules`: the creator rules the
 * certificate records are the ones the identity signed, the Launch Guard
 * holds exactly the bytes of the published record (none without rules, as
 * `launch` installs them), `RULES_BOUND` is set exactly when there are rules
 * (version 4; never on a version-3 certificate), and the rules are valid for
 * the launch's guard. Never throws.
 */
function checkLaunchRules(checks: Checks, i: RulesInputs): VerifiedRules {
  const { c } = i;
  const hash = c.rulesHash instanceof Uint8Array ? c.rulesHash : new Uint8Array(32);
  const none = isAllZero(hash);
  const report: VerifiedRules = { hash: toHex(hash), address: i.certRulesAddr, bytes: new Uint8Array(0), explanation: [], boundInPolicy: false, verified: false };
  const label = "Launch rules are the ones the creator signed, enforced by the Launch Guard";
  checks.run("launch.rules", label, () => {
    const problems: string[] = [];
    // (a) The rules the creator's identity signed.
    const att = i.attestation;
    if (att === null || !att.attested) problems.push("the launch rules the creator signed cannot be read: there is no valid attestation");
    else if (!bytesEqual(att.rulesHash, hash)) {
      problems.push(
        none
          ? "the creator signed launch rules, but the certificate records none"
          : isAllZero(att.rulesHash)
            ? "the certificate records launch rules, but the creator signed none"
            : "the certificate records other launch rules than the ones the creator signed",
      );
    }
    // The published rules record the certificate names: it must exist and hold bytes that hash to its address.
    let record: LaunchRulesAccount | null = null;
    if (i.certRulesAddr !== null) {
      const where = i.certRulesAddr.toBase58();
      const ra = i.certRulesAcc;
      if (ra === null || ra.data.length === 0) problems.push(`the launch rules are not published at ${where}, the address the certificate names`);
      else if (!ra.owner.equals(PROGRAM_IDS.launchpad)) problems.push(`the launch rules record ${where} is not owned by the launchpad`);
      else {
        try {
          record = decodeLaunchRules(i.certRulesAddr, ra.data);
          require_(record.launch.equals(c.launch), problems, "the launch rules record belongs to another launch");
        } catch (e) {
          problems.push(`the launch rules record ${where} is invalid (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
    // (b) The Launch Guard holds exactly those bytes: they hash to the certificate's hash (none for the zero hash)
    //     and equal the published record's.
    if (i.policy === null) problems.push(`the Launch Guard policy is unreadable, so the rules it enforces cannot be checked (${i.policyError ?? "missing"})`);
    else {
      const held = i.policy.rules;
      if (!bytesEqual(rulesHash(held), hash)) {
        problems.push(
          none
            ? "the Launch Guard enforces launch rules, but the certificate records none"
            : held.length === 0
              ? "the Launch Guard enforces no launch rules, but the certificate records some"
              : "the Launch Guard enforces other launch rules than the ones the certificate records",
        );
      } else if (record !== null) {
        // Implied by the hash (the record's bytes hash to its address); kept as defense in depth.
        require_(bytesEqual(held, record.bytes), problems, "the Launch Guard's rules are not the published rules record's");
      }
      report.boundInPolicy = none ? held.length === 0 : record !== null && bytesEqual(held, record.bytes);
    }
    // (c) RULES_BOUND: `launch` sets it exactly when the Launch Guard holds rules; a version-3 certificate never has it.
    const bound = (c.checks & CERTIFICATE_RULES_BOUND) !== 0;
    if (c.version === CERTIFICATE.V3_VERSION) require_(!bound, problems, "the certificate is version 3, from before launch rules existed, yet it says the Launch Guard holds launch rules (RULES_BOUND)");
    else if (none) require_(!bound, problems, "the certificate says the Launch Guard holds launch rules (RULES_BOUND), but there are none");
    else require_(bound, problems, "the launch has rules, but the certificate does not record that the Launch Guard holds them (RULES_BOUND)");
    // (d) The rules are valid for this launch's guard (as `publish_rules` and the Launch Guard checked them).
    if (!none && i.launch === null) problems.push("the Launch account is unreadable, so the rules cannot be checked against its guard");
    const explained = none ? explainLaunchRules(new Uint8Array(0), i.launch) : record === null ? null : explainLaunchRules(record.bytes, i.launch);
    if (explained !== null && explained.problem !== null) problems.push(explained.problem);
    report.bytes = record?.bytes ?? new Uint8Array(0);
    report.explanation = explained?.explanation ?? [];
    report.verified = problems.length === 0;
    if (problems.length > 0) return fail(problems.join("; "));
    if (none) {
      const v3 = c.version === CERTIFICATE.V3_VERSION ? " (version-3 certificate, written before launch rules existed)" : "";
      return pass(`No launch rules: the creator signed none and the Launch Guard holds none${v3}, so only the standard launch protections apply.`);
    }
    return pass(
      `The creator's post-quantum identity signed these launch rules (hash ${report.hash}, published at ${i.certRulesAddr!.toBase58()}), and the Launch Guard enforces exactly them until ${isoTs(c.guardEndTs)}: ${report.explanation.join(" ")}`,
    );
  });
  return report;
}

/**
 * Why the hook policy's snipe-shield end is not one the programs can write
 * (null: it is). `create_policy` writes the certificate's scheduled end
 * (`execute_end_ts`). The one later change is the hook's `end_snipe_shield`,
 * which only the launchpad's hook-authority PDA signs, only inside this
 * launch's `execute_batch` (the top-level instruction, checked by the hook)
 * and only for its own policy: it sets `min(end, now)` with `commit_end_ts <=
 * now < execute_end_ts`, and the same instruction marks the batch executed.
 * So a batch that has not executed leaves exactly the scheduled end, and an
 * executed one an end in `[commit_end_ts, execute_end_ts)`. Anything else (a
 * later end, an earlier one without a batch, a batch that left the shield
 * running) is refused.
 */
function snipeShieldEndProblem(policyEnd: bigint, c: CertificateAccount, lv: LaunchAccount | null): string | null {
  const scheduled = c.snipeShieldEndTs;
  if (policyEnd > scheduled) return "the snipe shield ends later than the certificate's scheduled end: nothing can move it later";
  if (lv === null) return policyEnd === scheduled ? null : "the snipe shield ends early but the launch is unreadable, so no executed batch can account for it";
  if (!lv.executed) {
    return policyEnd === scheduled ? null : "the snipe shield ends early although the batch has not executed: only the launchpad's execute_batch can end it early";
  }
  if (policyEnd >= lv.commitEndTs && policyEnd < lv.executeEndTs) return null;
  if (policyEnd === scheduled) return "the batch executed but the snipe shield still ends at its scheduled time: execute_batch always ends it when it buys";
  return `the snipe shield ends at ${policyEnd}, outside the execution window ${lv.commitEndTs}..${lv.executeEndTs} in which execute_batch can end it`;
}

async function postMigrationChecks(conn: Connection, checks: Checks, l: LaunchAccount, c: CertificateAccount): Promise<void> {
  let positions: LaunchLpPosition[] = [];
  try {
    positions = await findLaunchLpPositions(conn, l);
  } catch (e) {
    checks.add("damm.lpLocked", "Graduated liquidity is permanently locked", "fail", `Could not read the launch authority's positions: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // DBC creates the pool with its pool authority as `creator`. That field is
  // not a signature (anyone can name it on a public config), so the pool on
  // the canonical migration config is preferred, and the verdict is taken on
  // one pool only: extra pools cannot "add" locked liquidity to a launch.
  const migrated = positions.filter((p) => p.poolState.creator.equals(KNOWN_ACCOUNTS.dbcPoolAuthority));
  const config = DAMM_V2_MIGRATION_CONFIGS[l.migrationFeeOption];
  const canonicalPool = config === undefined ? null : dammV2PoolAddress(config, l.baseMint, WSOL_MINT);
  const byLocked = (a: LaunchLpPosition, b: LaunchLpPosition): number => (a.state.permanentLockedLiquidity > b.state.permanentLockedLiquidity ? -1 : a.state.permanentLockedLiquidity < b.state.permanentLockedLiquidity ? 1 : 0);
  const inCanonical = migrated.filter((p) => canonicalPool !== null && p.pool.equals(canonicalPool)).sort(byLocked);
  const main = inCanonical[0] ?? migrated.slice().sort(byLocked)[0];
  checks.run("damm.lpLocked", "Graduated liquidity is permanently locked, held by the launch authority", () => {
    if (main === undefined) return fail("The launch authority holds no position in a DBC-migrated DAMM v2 pool of (base, wSOL).");
    const inPool = migrated.filter((p) => p.pool.equals(main.pool));
    const locked = inPool.reduce((sum, p) => sum + p.state.permanentLockedLiquidity, 0n);
    if (locked === 0n) return fail(`No permanently locked liquidity in pool ${main.pool.toBase58()}.`);
    const vesting = inPool.find((p) => p.state.vestedLiquidity > 0n);
    if (vesting !== undefined) return fail(`Position ${vesting.position.toBase58()} has vesting liquidity.`);
    const parts = inPool.map(
      (p) =>
        `position ${p.position.toBase58()}: ${p.state.permanentLockedLiquidity} permanently locked${p.state.unlockedLiquidity > 0n ? `, ${p.state.unlockedLiquidity} unlocked but held by the launch authority PDA, which has no instruction to remove liquidity` : ""}`,
    );
    const others = positions.filter((p) => !p.pool.equals(main.pool)).map((p) => p.pool.toBase58());
    const extra = others.length > 0 ? ` The launch authority also holds positions in other pools (${[...new Set(others)].join(", ")}); they are not counted.` : "";
    return pass(`Pool ${main.pool.toBase58()}: ${parts.join("; ")}. NFTs owned by ${l.launchAuthority.toBase58()}.${extra}`);
  });
  if (main === undefined) return;
  checks.run("damm.pool", "DAMM v2 pool was created by DBC's migration", () => {
    const p = main.poolState;
    if (!p.tokenAMint.equals(l.baseMint) || !p.tokenBMint.equals(WSOL_MINT)) return fail("Pool mints are not (base, wSOL).");
    if (canonicalPool !== null && canonicalPool.equals(main.pool)) {
      return pass(`Pool ${main.pool.toBase58()} on the canonical ${MIGRATION_FEE_TIERS_BPS[l.migrationFeeOption]! / 100}% migration config.`);
    }
    return warn(`Pool ${main.pool.toBase58()} names DBC's pool authority as creator but is not on the canonical migration config for this fee tier.`);
  });
  checks.run("damm.status", "DAMM v2 pool is enabled", () =>
    main.poolState.poolStatus === DAMM_POOL_STATUS_ENABLED
      ? pass("Trading is enabled.")
      : warn("A DAMM v2 operator disabled this pool: swaps stopped. The locked liquidity cannot be withdrawn by anyone; it stops earning fees."),
  );
  checks.run("damm.fee", "Pool fee is what DBC's migration sets: the tier chosen at launch plus Meteora's default dynamic fee", () => {
    const f = compareDammPoolFee(main.poolState, c.migrationFeeOption);
    const tier = MIGRATION_FEE_TIERS_BPS[c.migrationFeeOption];
    const tierText = tier === undefined ? `option ${c.migrationFeeOption}` : `${tier / 100}%`;
    const most = f.maxTotalFeeNumerator === null ? "an amount this verifier cannot compute" : dammFeePercent(f.maxTotalFeeNumerator);
    const dynamic =
      f.maxVariableFeeNumerator === null
        ? "a dynamic fee that overflows DAMM v2's arithmetic"
        : f.maxVariableFeeNumerator === 0n
          ? "no dynamic fee"
          : `a dynamic fee of up to ${dammFeePercent(f.maxVariableFeeNumerator)} that rises with volatility`;
    if (f.matches) {
      return pass(`${tierText} base fee, as chosen at launch, plus ${dynamic} (Meteora's default on every pool its migration creates at this tier): at most ${most} per trade.`);
    }
    return warn(
      `The pool's fee is not what DBC's migration set for the ${tierText} tier (${f.differences.join("; ")}): a DAMM v2 operator changed it. It now charges ${dammFeePercent(f.baseFeeNumerator)} plus ${dynamic}, at most ${most} per trade.`,
    );
  });
}

function programChecks(checks: Checks, infos: Map<string, UpgradeableProgramInfo | Error | null>): void {
  const info = (p: PublicKey): UpgradeableProgramInfo => {
    const i = infos.get(p.toBase58());
    if (i === null || i === undefined) throw new Error(`program ${p.toBase58()} or its ProgramData is missing`);
    if (i instanceof Error) throw i;
    return i;
  };
  for (const [id, name, program] of [
    ["program.launchpad", "Noised launchpad", PROGRAM_IDS.launchpad],
    ["program.hook", "Noised Launch Guard hook", PROGRAM_IDS.hook],
  ] as const) {
    checks.run(id, `${name} program is immutable`, () => {
      const i = info(program);
      if (!i.executable) return fail("Program account is not executable.");
      return i.upgradeAuthority === null
        ? pass(`Finalized at slot ${i.lastDeploySlot}: nobody can change the code.`)
        : warn(`Still upgradeable by ${i.upgradeAuthority.toBase58()} (last deploy slot ${i.lastDeploySlot}); it becomes immutable after audit.`);
    });
  }
  for (const [id, name, program, slot] of [
    ["meteora.dbc", "Meteora DBC", PROGRAM_IDS.dbc, TRUST_ANCHORS.dbcLastDeploySlot],
    ["meteora.dammV2", "Meteora DAMM v2", PROGRAM_IDS.dammV2, TRUST_ANCHORS.dammV2LastDeploySlot],
  ] as const) {
    checks.run(id, `${name} code and upgrade authority are the reviewed ones`, () => {
      const i = info(program);
      const problems: string[] = [];
      require_(i.upgradeAuthority !== null && i.upgradeAuthority.equals(TRUST_ANCHORS.meteoraUpgradeAuthority), problems, `upgrade authority is ${b58(i.upgradeAuthority)}, recorded ${TRUST_ANCHORS.meteoraUpgradeAuthority.toBase58()}`);
      require_(i.lastDeploySlot === slot, problems, `last deployed at slot ${i.lastDeploySlot}, recorded ${slot}: the code changed since it was reviewed`);
      return problems.length === 0
        ? pass(`Upgradeable by the Meteora multisig vault ${TRUST_ANCHORS.meteoraUpgradeAuthority.toBase58()}; unchanged since slot ${slot}.`)
        : warn(problems.join("; "));
    });
  }
  checks.run("token2022.upgrade", "Token-2022 upgrade authority is the recorded multisig", () => {
    const i = info(KNOWN_ACCOUNTS.token2022);
    return i.upgradeAuthority !== null && i.upgradeAuthority.equals(TRUST_ANCHORS.token2022UpgradeAuthority)
      ? pass(`Upgradeable by the Token-2022 multisig vault ${TRUST_ANCHORS.token2022UpgradeAuthority.toBase58()} (last deploy slot ${i.lastDeploySlot}).`)
      : warn(`Upgrade authority is ${b58(i.upgradeAuthority)} (last deploy slot ${i.lastDeploySlot}); recorded ${TRUST_ANCHORS.token2022UpgradeAuthority.toBase58()}.`);
  });
}

async function trustedPartiesLive(conn: Connection, infos: Map<string, UpgradeableProgramInfo | Error | null>, listOperators: boolean): Promise<TrustedParty[]> {
  const parties = liveTrustedParties(infos);
  if (listOperators) parties.push(...(await dammOperators(conn)));
  return parties;
}

/**
 * `TRUSTED_PARTIES` with the live upgrade authorities and deploy slots of
 * DBC, DAMM v2 and Token-2022, and the two Noised upgrade authorities, from
 * program infos already read (keyed by program id; no RPC call).
 */
export function liveTrustedParties(infos: ReadonlyMap<string, UpgradeableProgramInfo | Error | null>): TrustedParty[] {
  const live = (p: PublicKey): string => {
    const i = infos.get(p.toBase58());
    if (i === null || i === undefined) return "not readable";
    if (i instanceof Error) return `not readable (${i.message})`;
    return `authority ${b58(i.upgradeAuthority)}, last deploy slot ${i.lastDeploySlot}`;
  };
  const parties: TrustedParty[] = TRUSTED_PARTIES.map((p) => ({ ...p }));
  parties[0] = { ...parties[0]!, note: `${parties[0]!.note} Live: DBC ${live(PROGRAM_IDS.dbc)}; DAMM v2 ${live(PROGRAM_IDS.dammV2)}.` };
  const t22 = parties.findIndex((p) => p.address !== null && p.address.equals(TRUST_ANCHORS.token2022Multisig));
  if (t22 >= 0) parties[t22] = { ...parties[t22]!, note: `${parties[t22]!.note} Live: ${live(KNOWN_ACCOUNTS.token2022)}.` };
  for (const [name, program] of [
    ["Noised launchpad upgrade authority", PROGRAM_IDS.launchpad],
    ["Noised Launch Guard upgrade authority", PROGRAM_IDS.hook],
  ] as const) {
    const i = infos.get(program.toBase58());
    const authority = i instanceof Error || i === null || i === undefined ? null : i.upgradeAuthority;
    parties.push({
      name,
      address: authority,
      kind: "upgrade-authority",
      note:
        i instanceof Error || i === null || i === undefined
          ? `Program ${program.toBase58()}: upgrade authority not readable.`
          : authority === null
            ? `Program ${program.toBase58()} is finalized: nobody can change it.`
            : `Can replace program ${program.toBase58()} until it is finalized after audit.`,
    });
  }
  return parties;
}

/** The DAMM v2 operator accounts, as trusted parties (one `getProgramAccounts`). */
async function dammOperators(conn: Connection): Promise<TrustedParty[]> {
  const parties: TrustedParty[] = [];
  try {
    const codec = idlCodecs().dammV2;
    const accounts = await conn.getProgramAccounts(PROGRAM_IDS.dammV2, {
      commitment: "confirmed",
      filters: [{ dataSize: codec.accountSize("Operator") }, { memcmp: { offset: 0, bytes: encodeBase58(codec.accountDiscriminator("Operator")) } }],
    });
    const ops: { address: PublicKey; op: DammOperator }[] = [];
    for (const a of accounts) {
      try {
        ops.push({ address: a.pubkey, op: decodeDammOperator(new Uint8Array(a.account.data)) });
      } catch {
        // not decodable: skip
      }
    }
    ops.sort((x, y) => x.op.whitelistedAddress.toBase58().localeCompare(y.op.whitelistedAddress.toBase58()));
    for (const { address, op } of ops) {
      const perms = DAMM_OPERATOR_PERMISSIONS.filter((_, bit) => (op.permission >> BigInt(bit)) & 1n);
      parties.push({
        name: "Meteora DAMM v2 operator (single key)",
        address: op.whitelistedAddress,
        kind: "operator",
        note: `Operator account ${address.toBase58()}; permissions: ${perms.join(", ") || "none"}.`,
      });
    }
    if (ops.length === 0) parties.push({ name: "Meteora DAMM v2 operators", address: null, kind: "operator", note: "The RPC returned no operator accounts." });
  } catch (e) {
    parties.push({
      name: "Meteora DAMM v2 operators",
      address: null,
      kind: "operator",
      note: `Could not list operator accounts (${e instanceof Error ? e.message : String(e)}); operators can disable pools and raise fees up to 10%.`,
    });
  }
  return parties;
}

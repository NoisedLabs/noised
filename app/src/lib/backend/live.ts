/**
 * LIVE backend (every default build): reads, builders, simulation and sending
 * all go through @noisedlabs/sdk to the RPC endpoint the user picked, which is
 * one of the build-time VITE_RPC_URL endpoints and the only hosts the CSP's
 * connect-src allows.
 *
 * What this module adds on top of the SDK is presentation and safety only:
 * plain-words explanations of failures that carry no program error code,
 * the Launch Guard's wallet-to-wallet pause and max-wallet cap as vault
 * warnings, mint display labels, the cluster (genesis hash) check, program
 * deployment status and the cluster clock. It never builds instructions and
 * never signs: every vault read, builder, recipient check and history search
 * is the SDK's own.
 */
import * as sdk from "@noisedlabs/sdk";
import {
  PublicKey,
  SendTransactionError,
  SYSVAR_CLOCK_PUBKEY,
  TransactionExpiredBlockheightExceededError,
  type Connection,
} from "@solana/web3.js";

import { cleanLabel, withRuntimeHint } from "../display";
import { errorMessage } from "../format";
import { explainAnyProgramError, MUTABLE_OWNER } from "../programErrors";
import { qslFromSdk, type QslVerdict } from "../qsl";
import { TransactionFailedError } from "./errors";
import { GENESIS_HASHES } from "./genesis";
import { programmableLive } from "./programmableLive";
import type { ChainBackend, ClusterCheck, MintInfo, ProgramStatus } from "./types";

export { GENESIS_HASHES };

const UPGRADEABLE_LOADER = sdk.KNOWN_ACCOUNTS.bpfLoaderUpgradeable;

// ------------------------------------------------------- error explanations ---

/** The innermost failing program and its custom error code (runtime logs list the innermost failure first). */
export function failedProgram(logs: readonly string[]): { programId: string; code: number | null } | null {
  for (const line of logs) {
    const m = /^Program (\w+) failed: (.*)$/.exec(line);
    if (m === null) continue;
    const custom = /custom program error: 0x([0-9a-fA-F]+)/.exec(m[2] ?? "");
    return { programId: m[1] ?? "", code: custom === null ? null : Number.parseInt(custom[1] ?? "", 16) };
  }
  return null;
}

/**
 * Program error codes named from the IDLs (through the SDK, then the app's
 * table of errors the SDK's IDLs do not name yet: lib/programErrors.ts);
 * anything else in plain words.
 */
export function explainFailure(raw: string, logs: readonly string[]): { error: string; errorCode: sdk.SimulationReport["errorCode"] } {
  const failed = failedProgram(logs);
  if (failed !== null && failed.code !== null) {
    const known = explainAnyProgramError(failed.programId, failed.code);
    if (known !== null) {
      return { error: `${known.program}: ${known.message} (${known.name}, ${failed.code})`, errorCode: { program: known.program, code: failed.code, name: known.name } };
    }
  }
  return { error: withRuntimeHint(raw, logs), errorCode: null };
}

type RawRpc = (method: string, args: unknown[]) => Promise<{ result?: unknown; error?: { message: string } }>;

/** Logs of a landed transaction (legacy or v1), best effort; web3.js 1.x cannot parse v1 itself. */
async function landedLogs(conn: Connection, signature: string): Promise<string[]> {
  const rpc = (conn as unknown as { _rpcRequest?: RawRpc })._rpcRequest;
  if (typeof rpc !== "function") return [];
  try {
    const res = await rpc.call(conn, "getTransaction", [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
    const meta = (res.result as { meta?: { logMessages?: unknown } | null } | null | undefined)?.meta;
    const logs = meta?.logMessages;
    return Array.isArray(logs) ? logs.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

/** Turn whatever sending threw into an error whose message explains the failure. */
async function explainSendError(conn: Connection, e: unknown): Promise<Error> {
  if (e instanceof TransactionFailedError) return e;
  if (e instanceof SendTransactionError) {
    const logs = e.logs ?? [];
    const x = explainFailure(e.transactionError.message, logs);
    return new TransactionFailedError(`Rejected before broadcast (the RPC's preflight simulation failed): ${x.error}`, logs, x.errorCode);
  }
  if (e instanceof TransactionExpiredBlockheightExceededError) {
    return new TransactionFailedError(
      `Transaction ${e.signature} was not confirmed before its blockhash expired, so it most likely did not land. Check it in the explorer before trying again.`,
      [],
      null,
    );
  }
  const message = errorMessage(e);
  const landed = /^transaction (\w+) failed: ([\s\S]*)$/.exec(message);
  if (landed !== null) {
    const logs = await landedLogs(conn, landed[1] ?? "");
    const x = explainFailure(landed[2] ?? "", logs);
    return new TransactionFailedError(`The transaction landed but failed on chain (its fee was paid): ${x.error}`, logs, x.errorCode);
  }
  return new Error(withRuntimeHint(message));
}

// ------------------------------------------------------------------ rpc ---

const simulateAndExplain: typeof sdk.simulateAndExplain = async (conn, tx, commitment = "confirmed") => {
  let report: sdk.SimulationReport;
  try {
    report = await sdk.simulateAndExplain(conn, tx, commitment);
  } catch (e) {
    throw new Error(`Simulation could not run: ${withRuntimeHint(errorMessage(e))}`);
  }
  // Program error codes are already named from the IDLs; explain the rest (an error the SDK's IDLs do not name yet included).
  if (report.ok || report.errorCode !== null || report.error === null) return report;
  const x = explainFailure(report.error, report.logs);
  return x.errorCode !== null ? { ...report, error: x.error, errorCode: x.errorCode } : { ...report, error: withRuntimeHint(report.error, report.logs) };
};

const sendAndConfirm: typeof sdk.sendAndConfirm = async (conn, tx, opts = {}) => {
  try {
    return await sdk.sendAndConfirm(conn, tx, opts);
  } catch (e) {
    throw await explainSendError(conn, e);
  }
};

// ------------------------------------------------------------- vault ---

const iso = (ts: bigint): string => new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");

/** The Launch Guard rules that still apply to a launch's token at `now` (null: not a live launch, graduated, or the guard ended). */
export interface ActiveGuard {
  guardEndTs: bigint;
  p2pLocked: boolean;
  maxWalletBps: number;
}

export function activeGuard(launch: Pick<sdk.LaunchAccount, "status" | "market" | "guardEndTs" | "p2pLocked" | "maxWalletBps"> | null, now: number): ActiveGuard | null {
  if (launch === null || launch.status !== "live" || launch.market?.hookActive !== true) return null;
  if (BigInt(Math.floor(now)) >= launch.guardEndTs) return null;
  return { guardEndTs: launch.guardEndTs, p2pLocked: launch.p2pLocked, maxWalletBps: launch.maxWalletBps };
}

/** The vault-mint warning for an active wallet-to-wallet pause (deposits and payout deliveries wait; `withdraw` moves no token). */
export function guardMintWarning(g: ActiveGuard | null): string | null {
  if (g === null || !g.p2pLocked) return null;
  return `The Noised Launch Guard pauses wallet-to-wallet transfers of this token until ${iso(g.guardEndTs)}: deposits into a vault and payout deliveries are refused until then. A withdrawal still executes (it only reserves the payout), and its payout can be delivered afterwards.`;
}

/** What the Launch Guard does to a payout: a p2p lock refuses its delivery and the max-wallet cap applies to the recipient, until the guard ends. */
export function guardRecipientWarnings(g: ActiveGuard | null): string[] {
  if (g === null) return [];
  const out: string[] = [];
  if (g.p2pLocked) {
    out.push(
      `The Noised Launch Guard pauses wallet-to-wallet transfers of this token until ${iso(g.guardEndTs)}: the withdrawal executes now and reserves the payout, but delivering it (release or release_to) is refused until then.`,
    );
  }
  if (g.maxWalletBps > 0) {
    out.push(
      `Until ${iso(g.guardEndTs)} the Launch Guard's max-wallet cap (${g.maxWalletBps / 100}% of the supply) applies to the recipient: a payout that would put the recipient's account above it is refused until the guard ends.`,
    );
  }
  return out;
}

async function launchGuardOf(conn: Connection, mint: PublicKey): Promise<ActiveGuard | null> {
  let launch: sdk.LaunchAccount | null = null;
  try {
    launch = await sdk.fetchLaunchByMint(conn, mint);
  } catch {
    launch = null;
  }
  if (launch === null) return null;
  return activeGuard(launch, (await chainUnixTime(conn)) ?? Math.floor(Date.now() / 1000));
}

/**
 * `open_vault`'s refusals and warnings (SDK), plus the Launch Guard's
 * wallet-to-wallet pause: during a launch's guard window with p2p_locked,
 * deposits into a vault and payout deliveries of that token are refused by
 * the hook (`withdraw` itself moves no token and is never refused).
 */
const checkVaultMint: typeof sdk.checkVaultMint = async (conn, mint) => {
  const base = await sdk.checkVaultMint(conn, mint);
  if (!base.eligible) return base;
  const warning = guardMintWarning(await launchGuardOf(conn, mint));
  return warning === null ? base : { ...base, warnings: [...base.warnings, warning] };
};

/**
 * The SDK's recipient check (with `opts.wallet`, the connected wallet whose
 * own token accounts it refuses), plus what the Launch Guard does to this
 * payout: a payout is a wallet-to-wallet transfer, so during the guard a p2p
 * lock refuses its delivery and the max-wallet cap applies to the recipient.
 * Both only delay the payout, never the withdrawal, and they are the same
 * for every recipient of this token: they join the token warnings
 * (`mintWarnings`), confirmed separately from the recipient's own.
 */
const checkRecipient: typeof sdk.checkRecipient = async (conn, destinationOwner, mint, vault, opts = {}) => {
  const base = await sdk.checkRecipient(conn, destinationOwner, mint, vault, opts);
  if (!base.ok) return base;
  const extra = guardRecipientWarnings(await launchGuardOf(conn, mint));
  return extra.length === 0 ? base : { ...base, mintWarnings: [...base.mintWarnings, ...extra] };
};

/** Token-2022's ImmutableOwner extension type (TLV type 7). */
const IMMUTABLE_OWNER = 7;

/**
 * Whether the token account at `account` can have its owner reassigned:
 * an SPL Token account, or a Token-2022 account without the ImmutableOwner
 * extension (associated token accounts of Token-2022 always have it). Null
 * when the account cannot be read as a token account.
 */
export function ownerIsMutable(owner: PublicKey, data: Uint8Array): boolean | null {
  if (owner.equals(sdk.KNOWN_ACCOUNTS.splToken)) return data.length === 165 ? true : null;
  if (!owner.equals(sdk.KNOWN_ACCOUNTS.token2022) || data.length < 165) return null;
  if (data.length === 165) return true;
  // Account type byte at 165 (2 = account), then TLV entries: u16 type, u16 length, value.
  if (data[165] !== 2) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let o = 166; o + 4 <= data.length; ) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    if (type === IMMUTABLE_OWNER) return false;
    if (type === 0 && len === 0) break;
    o += 4 + len;
  }
  return true;
}

/**
 * `release_to` (SDK), refused before anything is signed when the Launch
 * Guard would refuse it on chain (audit round 3, F2): while the token's
 * guard is on, the receiving account must have an immutable owner
 * (HookError 6010 MutableOwner). A recipient's own associated token account
 * always has one; another account it opened itself may not.
 */
const buildReleaseToTx: typeof sdk.buildReleaseToTx = async (conn, recipient, args, ...rest) => {
  if ((await launchGuardOf(conn, args.mint)) !== null) {
    const acc = await conn.getAccountInfo(args.destination, "confirmed");
    if (acc !== null && ownerIsMutable(acc.owner, new Uint8Array(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength)) === true) {
      throw new Error(`${MUTABLE_OWNER.message} (${MUTABLE_OWNER.name}, ${MUTABLE_OWNER.code}): ${args.destination.toBase58()} is not such an account. Receive into your own associated token account, or wait until the guard ends.`);
    }
  }
  return sdk.buildReleaseToTx(conn, recipient, args, ...rest);
};

// ------------------------------------------------------------- launch ---

/**
 * Bytes of rent the accounts `launch` creates besides the mint take
 * together, each with its 128-byte account overhead: the DBC pool and its
 * two vaults, the Launch Guard's policy and extra-account list and the
 * certificate. Measured: a launch's payer spends rent(mint) plus 2,378 such
 * bytes (LiteSVM, metadata fix stage, every record); rounded up.
 */
export const LAUNCH_ACCOUNTS_RENT_BYTES = 2_400;

/**
 * What `launch` takes from its payer: rent(mint, at the size the record gives it) + the other accounts' rent + two
 * signature fees (the payer's and the fresh mint's). Rents are read from the cluster, never hard-coded.
 */
const launchPayerLamports: ChainBackend["launchPayerLamports"] = async (conn, metadata) => {
  const [mint, others] = await Promise.all([
    sdk.rentExemptLamports(conn, sdk.launchedMintSpace(metadata)),
    // Rent is linear in (128 + size): the other accounts together cost what one account of their summed size does.
    sdk.rentExemptLamports(conn, LAUNCH_ACCOUNTS_RENT_BYTES - 128),
  ]);
  return mint + others + 2n * 5_000n;
};

// ------------------------------------------------------- fee recipients ---

/**
 * The fee recipients' check (audit round 3, F3), as the next SDK release's
 * `checkFeeRecipients` and today's `buildCreateLaunchTx` run it: the SDK's
 * `checkTokenRecipient` for wSOL on each wallet (`distribute` pays
 * ATA(wallet, wSOL)), one read for all of them.
 */
const checkFeeRecipients: ChainBackend["checkFeeRecipients"] = async (conn, recipients) => {
  for (const r of recipients) if (r === null || typeof r !== "object" || !(r.wallet instanceof PublicKey)) throw new TypeError("every recipient needs a wallet PublicKey");
  const infos = recipients.length === 0 ? [] : await conn.getMultipleAccountsInfo(recipients.map((r) => r.wallet), "confirmed");
  const refusals: string[] = [];
  const warnings: string[] = [];
  for (const [i, r] of recipients.entries()) {
    const info = infos[i] ?? null;
    const account = info === null ? null : { address: r.wallet, owner: info.owner, lamports: info.lamports, executable: info.executable, data: new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength) };
    const c = await sdk.checkTokenRecipient(conn, r.wallet, sdk.WSOL_MINT, sdk.KNOWN_ACCOUNTS.splToken, account);
    for (const reason of c.refusals) refusals.push(`recipients[${i}].wallet: ${reason}`);
    for (const w of c.warnings) warnings.push(`recipients[${i}].wallet: ${w}`);
  }
  return { ok: refusals.length === 0, refusals, warnings };
};

// ------------------------------------------------------------- mints ---

async function getMintInfo(conn: Connection, mint: PublicKey): Promise<MintInfo | null> {
  const acc = await conn.getAccountInfo(mint, "confirmed");
  if (acc === null) return null;
  if (!acc.owner.equals(sdk.KNOWN_ACCOUNTS.splToken) && !acc.owner.equals(sdk.KNOWN_ACCOUNTS.token2022)) return null;
  const data = new Uint8Array(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
  let parsed: sdk.ParsedMint;
  try {
    parsed = sdk.parseMint(acc.owner, data);
  } catch {
    // The strict parser refuses unknown extensions (the vault and shield refuse
    // such mints too); amounts can still be shown from the base mint layout.
    const isT22 = acc.owner.equals(sdk.KNOWN_ACCOUNTS.token2022);
    const mintShaped = data.length === 82 || (isT22 && data.length > 165 && data[165] === 1);
    if (!mintShaped || data[45] !== 1) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { address: mint, tokenProgram: acc.owner, decimals: data[44] ?? 0, supply: view.getBigUint64(36, true), symbol: null, name: null };
  }
  let symbol: string | null = null;
  let name: string | null = null;
  if (mint.equals(sdk.WSOL_MINT)) {
    symbol = "wSOL";
    name = "Wrapped SOL";
  } else {
    try {
      const md = sdk.tokenMetadataOf(parsed);
      if (md !== null && md.mint.equals(mint)) {
        symbol = cleanLabel(md.symbol, 10);
        name = cleanLabel(md.name, 32);
      }
    } catch {
      // Malformed metadata: show the address only.
    }
  }
  return { address: mint, tokenProgram: parsed.programId, decimals: parsed.decimals, supply: parsed.supply, symbol, name };
}

// ---------------------------------------------------------- cluster ---

async function checkCluster(conn: Connection, expected: sdk.Cluster): Promise<ClusterCheck> {
  let hash: string;
  try {
    hash = await conn.getGenesisHash();
  } catch (e) {
    return { state: "error", genesisHash: null, detail: `Could not read the endpoint's genesis hash: ${withRuntimeHint(errorMessage(e))}` };
  }
  const actual = (Object.keys(GENESIS_HASHES) as (keyof typeof GENESIS_HASHES)[]).find((k) => GENESIS_HASHES[k] === hash) ?? null;
  if (expected === "localnet") {
    return {
      state: "unverified",
      genesisHash: hash,
      detail: actual === null ? `Local cluster, genesis ${hash}.` : `This localnet build is connected to ${actual} (genesis ${hash}).`,
    };
  }
  if (hash === GENESIS_HASHES[expected]) return { state: "match", genesisHash: hash, detail: `Genesis hash ${hash} is ${expected}'s.` };
  return {
    state: "mismatch",
    genesisHash: hash,
    detail: `This build targets ${expected}, but the RPC endpoint serves ${actual ?? "another cluster"} (genesis ${hash}).`,
  };
}

const PROGRAMS: readonly { label: string; id: PublicKey }[] = [
  { label: "Noised launchpad", id: sdk.PROGRAM_IDS.launchpad },
  { label: "Noised Launch Guard hook", id: sdk.PROGRAM_IDS.hook },
  { label: "Noised PQ vault", id: sdk.PROGRAM_IDS.vault },
  { label: "Noised shield", id: sdk.PROGRAM_IDS.shield },
  { label: "Meteora DBC", id: sdk.PROGRAM_IDS.dbc },
  { label: "Meteora DAMM v2", id: sdk.PROGRAM_IDS.dammV2 },
  { label: "Token-2022", id: sdk.KNOWN_ACCOUNTS.token2022 },
  { label: "SPL Token", id: sdk.KNOWN_ACCOUNTS.splToken },
];

const u32le = (b: Uint8Array, o: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);

/**
 * Deployment state of each program: executable account present, loader,
 * upgrade authority and last deploy slot (loader-v3 `Program` and
 * `ProgramData` layouts; only the first 36 / 45 bytes are fetched).
 */
async function programStatuses(conn: Connection): Promise<ProgramStatus[]> {
  const infos = await conn.getMultipleAccountsInfo(
    PROGRAMS.map((p) => p.id),
    { commitment: "confirmed", dataSlice: { offset: 0, length: 36 } },
  );
  const programData: (PublicKey | null)[] = infos.map((info) => {
    if (info === null || !info.owner.equals(UPGRADEABLE_LOADER) || info.data.length < 36) return null;
    const data = new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength);
    return u32le(data, 0) === 2 ? new PublicKey(data.subarray(4, 36)) : null;
  });
  const wanted = programData.filter((k): k is PublicKey => k !== null);
  const pdInfos = wanted.length === 0 ? [] : await conn.getMultipleAccountsInfo(wanted, { commitment: "confirmed", dataSlice: { offset: 0, length: 45 } });
  const byAddress = new Map(wanted.map((k, i) => [k.toBase58(), pdInfos[i] ?? null]));
  return PROGRAMS.map((p, i): ProgramStatus => {
    const info = infos[i] ?? null;
    if (info === null) return { label: p.label, programId: p.id, state: "missing", loader: null, upgradeable: null, upgradeAuthority: null, lastDeploySlot: null };
    const base = { label: p.label, programId: p.id, loader: info.owner };
    if (!info.executable) return { ...base, state: "not-executable", upgradeable: null, upgradeAuthority: null, lastDeploySlot: null };
    if (!info.owner.equals(UPGRADEABLE_LOADER)) return { ...base, state: "deployed", upgradeable: false, upgradeAuthority: null, lastDeploySlot: null };
    const pdKey = programData[i];
    const pd = pdKey ? (byAddress.get(pdKey.toBase58()) ?? null) : null;
    if (pd === null || pd.data.length < 45) return { ...base, state: "unreadable", upgradeable: null, upgradeAuthority: null, lastDeploySlot: null };
    const d = new Uint8Array(pd.data.buffer, pd.data.byteOffset, pd.data.byteLength);
    if (u32le(d, 0) !== 3 || (d[12] ?? 2) > 1) return { ...base, state: "unreadable", upgradeable: null, upgradeAuthority: null, lastDeploySlot: null };
    const authority = d[12] === 1 ? new PublicKey(d.subarray(13, 45)) : null;
    const slot = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(4, true);
    return { ...base, state: "deployed", upgradeable: authority !== null, upgradeAuthority: authority, lastDeploySlot: slot };
  });
}

/**
 * Whether `initialize_protocol` has run on this cluster: an account owned by the launchpad sits at its `Protocol`
 * address. Only the launchpad can create an account it owns there, so lamports someone sent to the address (a
 * system-owned account) do not count. Reads 8 bytes; throws when the RPC cannot answer.
 */
async function protocolInitialized(conn: Connection): Promise<boolean> {
  const info = await conn.getAccountInfo(sdk.protocolAddress(), { commitment: "confirmed", dataSlice: { offset: 0, length: 8 } });
  return info !== null && info.owner.equals(sdk.PROGRAM_IDS.launchpad) && info.data.length > 0;
}

/** `Clock::unix_timestamp` (i64 LE at offset 32 of the Clock sysvar): the time the programs check windows against. */
async function chainUnixTime(conn: Connection): Promise<number | null> {
  try {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, { commitment: "confirmed", dataSlice: { offset: 32, length: 8 } });
    if (info === null || info.data.length < 8) return null;
    const ts = new DataView(info.data.buffer, info.data.byteOffset, 8).getBigInt64(0, true);
    return Number(ts);
  } catch {
    return null;
  }
}

// ------------------------------------------------------ change events ---

/** Reads refresh after every confirmed transaction and every 30 s while the page is visible. */
const REFRESH_MS = 30_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribeToChainChanges(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === null) {
    timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") emit();
    }, REFRESH_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// ---------------------------------------------------------------- QSL-1 ---

/**
 * The SDK's QSL-1 checker (`checkQsl1`, SDK 0.5.0: the standard's §7 over live accounts, with the endpoint's genesis
 * hash deciding the cluster: levels exist on mainnet only) and its badge words (`qslBadge`, Appendix A).
 */
async function checkQsl1(conn: Connection, mint: PublicKey): Promise<QslVerdict> {
  const result = await sdk.checkQsl1(conn, mint);
  return qslFromSdk(result, sdk.qslBadge(result));
}

// ----------------------------------------------------------- backend ---

export const backend: ChainBackend = {
  mode: "live",

  fetchLaunch: sdk.fetchLaunch,
  fetchLaunchByMint: sdk.fetchLaunchByMint,
  listLaunches: sdk.listLaunches,
  fetchCommit: sdk.fetchCommit,
  fetchAttestation: sdk.fetchAttestation,
  fetchPayoutVault: sdk.fetchPayoutVault,
  buildCreateLaunchTx: sdk.buildCreateLaunchTx,
  buildLaunchTx: sdk.buildLaunchTx,
  buildCommitTx: sdk.buildCommitTx,
  buildExecuteBatchTx: sdk.buildExecuteBatchTx,
  buildClaimTx: sdk.buildClaimTx,
  buildClaimFeesTx: sdk.buildClaimFeesTx,
  buildClaimLpFeesTx: sdk.buildClaimLpFeesTx,
  buildDistributeTx: sdk.buildDistributeTx,
  buildSwapTx: sdk.buildSwapTx,
  checkFeeRecipients,

  buildPlannedCreateLaunchTx: sdk.buildPlannedCreateLaunchTx,
  throwawayPayerFunding: sdk.throwawayPayerFunding,
  buildFundThrowawayPayerTx: sdk.buildFundThrowawayPayerTx,
  buildPlannedPublishTx: sdk.buildPlannedPublishTx,
  sendPublishMetadataTx: sdk.sendPublishMetadataTx,
  waitForTokenMeta: sdk.waitForTokenMeta,
  buildPlannedAttestTx: sdk.buildPlannedAttestTx,
  sendAttestLaunchTx: sdk.sendAttestLaunchTx,
  confirmAttestation: sdk.confirmAttestation,
  landOrBurnPending: sdk.landOrBurnPending,
  buildSweepPayerTx: sdk.buildSweepPayerTx,
  getLaunchFlowStatus: sdk.getLaunchFlowStatus,
  verifyAttestation: sdk.verifyAttestation,
  fetchTokenMetaForLaunch: sdk.fetchTokenMetaForLaunch,
  fetchTokenMetaForMint: sdk.fetchTokenMetaForMint,
  rentExemptLamports: sdk.rentExemptLamports,
  launchPayerLamports,

  verifyLaunch: sdk.verifyLaunch,
  checkQsl1,

  checkVaultMint,
  buildOpenVaultTx: sdk.buildOpenVaultTx,
  buildDepositTx: sdk.buildDepositTx,
  buildWithdrawTx: sdk.buildWithdrawTx,
  buildWithdrawTxWithFallback: sdk.buildWithdrawTxWithFallback,
  buildReleaseTx: sdk.buildReleaseTx,
  buildReleaseToTx,
  fetchVault: sdk.fetchVault,
  fetchPayout: sdk.fetchPayout,
  listPayouts: sdk.listPayouts,
  checkRecipient,
  findPendingWithdrawal: sdk.findPendingWithdrawal,
  prepareWithdrawal: sdk.prepareWithdrawal,
  scanVaults: sdk.scanVaults,
  buildFundFeePayerTx: sdk.buildFundFeePayerTx,
  buildRefundFeePayerTx: sdk.buildRefundFeePayerTx,

  fetchShield: sdk.fetchShield,
  buildCreateShieldTx: sdk.buildCreateShieldTx,
  buildWrapTx: sdk.buildWrapTx,
  buildUnwrapTx: sdk.buildUnwrapTx,

  getSolBalance: sdk.getSolBalance,
  getTokenBalance: sdk.getTokenBalance,
  getTokenSupply: sdk.getTokenSupply,
  simulateAndExplain,
  sendAndConfirm,

  getMintInfo,
  checkCluster,
  programStatuses,
  protocolInitialized,
  chainUnixTime,
  subscribeToChainChanges,
  notifyChainChanged: emit,
  demoMints: () => [],
  fundDemoWallet: () => undefined,
  resetDemoState: () => {
    throw new Error("There is no demo state in a live build.");
  },
  demoPasskeyMaster: () => {
    throw new Error("There is no demo passkey in a live build.");
  },
  programmable: programmableLive,
};

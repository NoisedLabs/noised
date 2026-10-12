/**
 * Launchpad transaction builders (SPEC §1.4, §4.1, PQ v2). Account order,
 * flags and fixed addresses come from the launchpad IDL; remaining accounts
 * follow the program's conventions:
 *
 * - `execute_batch`: `[extra_account_meta_list, policy, instructions sysvar,
 *   noised_hook]` (exactly, in this order: `hook_accounts::validate`); it
 *   must be a top-level instruction (the hook recognizes the batch buy from
 *   the instructions sysvar);
 * - `claim`: the same four while the mint's transfer hook is active and
 *   tokens are paid;
 * - `distribute`: `[wallet_i, wSOL ATA_i]` for every stored recipient, in order.
 *
 * Builders return unsigned legacy `Transaction`s with `feePayer` and a recent
 * blockhash set (`buildLaunchTx` is also signed by the fresh mint keypair),
 * each starting with a measured tight `SetComputeUnitLimit` (`COMPUTE_UNITS`)
 * and, when `computeUnitPrice` is given, a `SetComputeUnitPrice`: the batch
 * and launch windows are contested write locks, so keepers and committers
 * should pay a priority fee. Every builder re-reads the launch and refuses
 * states the program would reject deterministically; the commit and
 * execution windows are left to simulation, the attested launch window is
 * checked against the cluster clock.
 */
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, type AccountMeta, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual, isAllZero, isU64, randomBytes, U64_MAX } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS, WSOL_MINT } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { decodeDammPool, decodeDammPosition, decodeDbcTransferHookPool, u256le, type DammPool, type DammPosition } from "../meteora/state.js";
import { fetchTokenMeta } from "../metadata/record.js";
import {
  associatedTokenAddress,
  attestationAddress,
  certificateAddress,
  commitAddress,
  dammV2PositionAddress,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  extraAccountMetaListAddress,
  hookAuthorityAddress,
  hookPolicyAddress,
  launchAddress,
  launchPdas,
  launchPdasFromLaunch,
  launchRulesAddress,
  payoutVaultAddress,
  tokenMetaAddress,
  wsolAta,
} from "../pda.js";
import { computeBudgetInstructions, computeUnitLimitOf, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { getAccount, getAccounts, ownedBy } from "../rpc/fetch.js";
import { activeHookProgram, noisedHookAccounts } from "../token/hook.js";
import { parseMint, parseTokenAccount } from "../token/mint.js";
import { compileV1Message, signV1Message } from "../tx/v1.js";
import type { LaunchAccount, LaunchParams, LaunchParamsInput } from "../types.js";
import { activeRecipients, fetchAttestation, fetchCommit, fetchLaunch, fetchLaunchRules, fetchPayoutVault, fetchProtocol } from "./accounts.js";
import { batchShare, validateLaunchParams } from "./policy.js";
import { checkNowSecs, clusterUnixTime, inLaunchWindow } from "./window.js";
import { checkFeeRecipients, isPqVaultOf } from "./recipients.js";

/**
 * Default compute-unit limits (`SetComputeUnitLimit`), from the LiteSVM
 * measurements of the PQ v2 programs (docs and PQV2_SDK_IMPACT) with a
 * margin: largest `create_launch` 83.8k; `launch` 148.7k-221.1k measured
 * with the on-chain metadata record (an inline uri costs the most; plus
 * 1,500 per extra bump-search step of the mint's addresses: 258.6k at a
 * one-in-a-million 47 extra steps), so 300k for every record; `commit`
 * naming two vaults 44k-47k, plus the batch escrow the first commit creates,
 * the committer's wSOL ATA, the wrap and the close (about 60k more at
 * worst); `execute_batch` 114k-174k (8-point curve, its `end_snipe_shield`
 * CPI included); a third-party claim into two vaults 64k-81k (both ATAs
 * created, hooked transfer); `[launch, commit]` 194k plus the wrap. The fee
 * claims and `distribute` were not re-measured and keep generous limits.
 * Override per call with `computeUnitLimit` (`simulateComputeUnits` sizes
 * one: build with `computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT`, simulate,
 * rebuild with the result).
 */
export const COMPUTE_UNITS = {
  createLaunch: 100_000,
  launch: 300_000,
  commit: 130_000,
  executeBatch: 220_000,
  claim: 120_000,
  claimFees: 300_000,
  claimLpFees: 300_000,
  distribute: 400_000,
  /** `[launch, commit]` v1 bundle (config word): `launch`'s 300k and `commit`'s 130k. */
  launchCommitBundle: 430_000,
} as const;

/**
 * Loaded-accounts-data limit of the `[launch, commit]` v1 bundle: the
 * launchpad (about 754 KB), DBC (about 2.3 MB), Token-2022 (about 1.4 MB),
 * SPL Token, the ATA and hook programs and the accounts, with margin.
 */
export const LAUNCH_BUNDLE_LOADED_ACCOUNTS_BYTES = 8 * 1024 * 1024;

const T22 = KNOWN_ACCOUNTS.token2022;
const launchpad = (): ReturnType<typeof idlCodecs>["launchpad"] => idlCodecs().launchpad;

async function finish(conn: Connection, feePayer: PublicKey, ixs: TransactionInstruction[], units: number, opts: ComputeBudgetOptions): Promise<Transaction> {
  const tx = new Transaction();
  tx.add(...computeBudgetInstructions(opts, units));
  tx.add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/** The launch, which must exist and be live; its PDAs are re-derived and compared. */
async function liveLaunch(conn: Connection, launch: PublicKey): Promise<LaunchAccount> {
  const l = await fetchLaunch(conn, launch);
  if (l === null) throw new Error(`launch ${launch.toBase58()} does not exist`);
  checkPdas(l);
  if (l.status !== "live") throw new Error("launch is not live yet (call launch first)");
  return l;
}

function checkPdas(l: LaunchAccount): void {
  const p = launchPdasFromLaunch(l.publicKey);
  if (
    !launchAddress(l.creator, l.launchSeed).equals(l.publicKey) ||
    !p.launchAuthority.equals(l.launchAuthority) ||
    !p.batchAuthority.equals(l.batchAuthority) ||
    !p.dbcConfig.equals(l.dbcConfig)
  ) {
    throw new Error("launch account PDAs do not match their seeds");
  }
}

function launchParamsArg(p: LaunchParams): LaunchParams {
  return {
    tokenDecimal: p.tokenDecimal,
    sqrtStartPrice: p.sqrtStartPrice,
    curve: p.curve.map((c) => ({ sqrtPrice: c.sqrtPrice, liquidity: c.liquidity })),
    migrationQuoteThreshold: p.migrationQuoteThreshold,
    baseFee: { ...p.baseFee },
    dynamicFee: p.dynamicFee === null ? null : { ...p.dynamicFee },
    migrationFeeOption: p.migrationFeeOption,
    openDelaySecs: p.openDelaySecs,
    guardSecs: p.guardSecs,
    maxWalletBps: p.maxWalletBps,
    maxBuyBps: p.maxBuyBps,
    p2pLocked: p.p2pLocked,
    batchWalletCap: p.batchWalletCap,
    batchTotalCap: p.batchTotalCap,
    recipients: p.recipients.map((r) => ({ wallet: r.wallet, bps: r.bps })),
    pqIdentity: p.pqIdentity,
  };
}

/** borsh(LaunchParams), byte-identical to the program's `params.serialize` (`pq_identity` last). */
export function serializeLaunchParams(p: LaunchParams): Uint8Array {
  return launchpad().encodeType("LaunchParams", launchParamsArg(p));
}

/** Decode borsh(LaunchParams) (e.g. from a `create_launch` instruction). */
export function deserializeLaunchParams(data: Uint8Array): LaunchParams {
  return launchpad().decodeType<LaunchParams>("LaunchParams", data);
}

// ---------------------------------------------------------------- create ---

/** `buildCreateLaunchTx` options. */
export interface CreateLaunchOptions extends ComputeBudgetOptions {
  /** 32 bytes; default: fresh random bytes. The launch is `["launch", creator, launchSeed]`. */
  launchSeed?: Uint8Array | undefined;
}

/**
 * `create_launch`: validates `params` (refusing what the program would
 * refuse, including recipients equal to this launch's own PDAs and an
 * all-zero `pqIdentity`) and creates the DBC config. Fee recipients are paid
 * at ATA(wallet, wSOL), so a recipient may be a wSOL PQ vault (the vault's
 * own token account: recommended); recipients whose ATA nobody could ever
 * move are refused (vault-program accounts that are not wSOL vaults, token
 * accounts and mints, programs, off-curve addresses with no account).
 * `pqIdentity` must be the id of an identity this creator holds: only it can
 * attest the launch, and nothing else can make it go live. The token's name,
 * symbol and document are not launch parameters: they are a record published
 * afterwards (`buildPublishMetadataTx`) and signed by the attestation.
 * `warnings`: fee recipients that are accounts of other programs (only that
 * program can move what their token account receives).
 */
export async function buildCreateLaunchTx(
  conn: Connection,
  creator: PublicKey,
  params: LaunchParamsInput,
  opts: CreateLaunchOptions = {},
): Promise<{ tx: Transaction; launch: PublicKey; launchSeed: Uint8Array; warnings: string[] }> {
  const launchSeed = opts.launchSeed ?? randomBytes(32);
  const pdas = launchPdas(creator, launchSeed);
  const check = validateLaunchParams(params, [pdas.launchAuthority, pdas.batchAuthority]);
  if (!check.ok) throw new Error(`invalid launch parameters:\n${check.errors.join("\n")}`);
  const wallets = params.recipients.map((r) => r.wallet);
  const [protocol, accounts] = await Promise.all([fetchProtocol(conn), getAccounts(conn, [pdas.launch, ...wallets])]);
  if (protocol === null) throw new Error("the launchpad protocol account is not initialized");
  const existing = accounts[0] ?? null;
  if (existing !== null && existing.data.length > 0) throw new Error("a launch with this seed already exists");
  const { refusals, warnings } = await checkFeeRecipients(conn, params.recipients, accounts.slice(1), { launch: pdas.launch });
  if (refusals.length > 0) throw new Error(`invalid fee recipients:\n${refusals.join("\n")}`);
  const ix = buildInstruction(
    launchpad(),
    PROGRAM_IDS.launchpad,
    "create_launch",
    { creator, protocol: pdas.protocol, launch: pdas.launch, launchAuthority: pdas.launchAuthority, dbcConfig: pdas.dbcConfig },
    { launchSeed, params: launchParamsArg(params) },
  );
  return { tx: await finish(conn, creator, [ix], COMPUTE_UNITS.createLaunch, opts), launch: pdas.launch, launchSeed, warnings };
}

/** `buildLaunchTx` options. */
export interface LaunchTxOptions extends ComputeBudgetOptions {
  /** Bigint unix seconds to check the attested window against (default: the cluster's Clock sysvar). */
  nowSecs?: bigint | undefined;
}

/** The checks and the `launch` instruction shared by `buildLaunchTx` and the v1 bundle. */
async function launchInstruction(
  conn: Connection,
  payer: PublicKey,
  launch: PublicKey,
  baseMint: Keypair,
  nowSecs: bigint | undefined,
): Promise<{ ix: TransactionInstruction; launch: LaunchAccount }> {
  if (!(payer instanceof PublicKey) || !(launch instanceof PublicKey)) throw new TypeError("payer and launch must be PublicKeys");
  if (nowSecs !== undefined) checkNowSecs(nowSecs);
  const [l, attestation] = await Promise.all([fetchLaunch(conn, launch), fetchAttestation(conn, launch)]);
  if (l === null) throw new Error(`launch ${launch.toBase58()} does not exist`);
  checkPdas(l);
  if (l.status !== "configured") throw new Error("launch has already been launched");
  if (attestation === null) throw new Error("the launch is not attested yet: its post-quantum identity must sign it first (attest_launch)");
  if (!attestation.attested) {
    throw new Error("the launch's attestation is empty: a signature only burned its leaf (wrong identity, metadata or window); the identity must attest again (AttestationMismatch)");
  }
  if (!attestation.launch.equals(launch) || !bytesEqual(attestation.pqIdentity, l.pqIdentity)) {
    throw new Error("the attestation does not belong to this launch or its identity (AttestationMismatch)");
  }
  // The record the attestation names: `launch` takes the mint's name, symbol and uri from it (AccountNotInitialized without it).
  if ((await fetchTokenMeta(conn, launch, attestation.metadataHash)) === null) {
    throw new Error("the metadata record the attestation names does not exist (AccountNotInitialized): it was never published, or the RPC is behind");
  }
  // The rules record the attestation names (the 23rd account), present exactly when its rules hash is not zero
  // (AttestationMismatch otherwise); `launch` installs its bytes in the hook policy.
  const rules = isAllZero(attestation.rulesHash) ? null : launchRulesAddress(launch, attestation.rulesHash);
  if (rules !== null && (await fetchLaunchRules(conn, launch, attestation.rulesHash)) === null) {
    throw new Error("the rules record the attestation names does not exist (AccountNotInitialized): it was never published, or the RPC is behind");
  }
  const now = nowSecs === undefined ? await clusterUnixTime(conn) : nowSecs;
  if (!inLaunchWindow(now, attestation.notBefore, attestation.notAfter)) {
    const when = (t: bigint): string => `${new Date(Number(t) * 1000).toISOString()} (${t})`;
    throw new Error(`NotLaunchWindow: the attested window runs from ${when(attestation.notBefore)} to ${when(attestation.notAfter)} inclusive; the cluster time is ${now}`);
  }
  const mint = baseMint.publicKey;
  const mintAcc = await getAccount(conn, mint);
  // A fresh address may hold lamports (anyone can send SOL to it); DBC's
  // `init` tops it up. It must not hold data or belong to a program.
  if (mintAcc !== null && (mintAcc.data.length > 0 || !mintAcc.owner.equals(SystemProgram.programId))) {
    throw new Error("the base mint keypair must be fresh (its address is already in use)");
  }
  const pool = dbcPoolAddress(l.dbcConfig, mint, WSOL_MINT);
  const ix = buildInstruction(
    launchpad(),
    PROGRAM_IDS.launchpad,
    "launch",
    {
      payer,
      launch,
      launchAuthority: l.launchAuthority,
      dbcConfig: l.dbcConfig,
      baseMint: mint,
      pool,
      baseVault: dbcTokenVaultAddress(mint, pool),
      quoteVault: dbcTokenVaultAddress(WSOL_MINT, pool),
      hookAuthority: hookAuthorityAddress(),
      extraAccountMetaList: extraAccountMetaListAddress(mint),
      policy: hookPolicyAddress(mint),
      certificate: certificateAddress(mint),
      attestation: attestationAddress(launch),
      tokenMeta: tokenMetaAddress(launch, attestation.metadataHash),
      rules,
    },
  );
  return { ix, launch: l };
}

/**
 * `launch`: creates the DBC pool and mint (`baseMint` must be a fresh
 * keypair; it signs here), installs the hook policy and writes the
 * certificate (version 4). It takes no arguments: the mint's name, symbol
 * and uri come from the metadata record the attestation names
 * (`token_meta`), and the hook policy's rules from the rules record it names
 * (`rules`, the 23rd and last account: the record, or the launchpad program
 * id when the attested rules hash is zero), so the transaction is 988 bytes
 * without rules and 1,020 bytes with them (legacy, both compute-budget
 * instructions) for every record and rule set. Permissionless inside the
 * attested window: `payer` (account 0) is anyone and only pays rent (the
 * mint's included); no creator signature. Refuses a launch without an
 * attestation, an empty (burn-only) attestation, a missing record (metadata
 * or rules) and a
 * time outside `notBefore..=notAfter` (NotLaunchWindow, cluster clock unless
 * `nowSecs` is given). Inside the window the first `launch` to land wins:
 * send it alone at `notBefore`, with a priority fee (`computeUnitPrice`).
 * The payer signs next; do not modify the transaction afterwards (the mint
 * keypair already signed).
 */
export async function buildLaunchTx(conn: Connection, payer: PublicKey, launch: PublicKey, baseMint: Keypair, opts: LaunchTxOptions = {}): Promise<{ tx: Transaction }> {
  const { ix } = await launchInstruction(conn, payer, launch, baseMint, opts.nowSecs);
  const tx = await finish(conn, payer, [ix], COMPUTE_UNITS.launch, opts);
  tx.partialSign(baseMint);
  return { tx };
}

// ----------------------------------------------------------------- batch ---

/** The owner's wSOL ATA exists with data now (a transaction that creates it should close it again). */
async function wsolAtaExists(conn: Connection, owner: PublicKey): Promise<boolean> {
  const acc = await getAccount(conn, wsolAta(owner));
  return acc !== null && acc.data.length > 0;
}

/** Close the owner's wSOL ATA: every lamport in it (rent and any wSOL) goes to the owner as SOL. */
function closeWsolAta(owner: PublicKey): TransactionInstruction {
  return createCloseAccountInstruction(wsolAta(owner), owner, owner, [], KNOWN_ACCOUNTS.splToken);
}

/** Wrap, commit, and close the wSOL ATA again when this transaction creates it (review L5). */
function commitInstructions(
  owner: PublicKey,
  launch: PublicKey,
  batchAuthority: PublicKey,
  lamports: bigint,
  tokenOwner: PublicKey,
  refundOwner: PublicKey,
  wsolExisted: boolean,
): TransactionInstruction[] {
  const ownerWsol = wsolAta(owner);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ownerWsol, owner, WSOL_MINT, KNOWN_ACCOUNTS.splToken),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ownerWsol, lamports }),
    createSyncNativeInstruction(ownerWsol, KNOWN_ACCOUNTS.splToken),
    buildInstruction(
      launchpad(),
      PROGRAM_IDS.launchpad,
      "commit",
      {
        owner,
        launch,
        commit: commitAddress(launch, owner),
        batchAuthority,
        ownerQuoteAccount: ownerWsol,
        batchQuoteEscrow: wsolAta(batchAuthority),
        tokenOwner,
        refundOwner,
        // `["payout-vault", launch, token_owner]` when the tokens go to a vault; Anchor's None otherwise.
        payoutVault: tokenOwner.equals(owner) ? null : payoutVaultAddress(launch, tokenOwner),
      },
      { amount: lamports },
    ),
  ];
  if (!wsolExisted) ixs.push(closeWsolAta(owner));
  return ixs;
}

/** `buildCommitTx` options. */
export interface CommitOptions extends ComputeBudgetOptions {
  /**
   * Receives the tokens at claim (its canonical Token-2022 ATA): the
   * committer (default) or an opened PQ vault of the base mint, so the
   * share lands straight in post-quantum custody. Fixed by the first
   * commit; later commits default to the stored one.
   */
  tokenOwner?: PublicKey | undefined;
  /** Receives the wSOL refund (its canonical wSOL ATA): the committer (default) or an opened PQ vault of wSOL. Fixed by the first commit. */
  refundOwner?: PublicKey | undefined;
}

/**
 * `commit`: wraps `lamports` SOL into the owner's wSOL ATA and commits it to
 * the fair-open batch. Only the caps refuse: the per-wallet cap on the
 * owner's commit and, when the tokens go to a PQ vault, the same cap on
 * everything committed for that vault (`PayoutVault`, by anyone: CapExceeded);
 * an amount above the total cap is accepted and filled pro rata
 * (`expectedBatchFill`). Payout owners are checked like the program does
 * (InvalidPayoutOwner): the committer or a PQ vault of the right mint, fixed
 * by the first commit. When the wSOL ATA does not exist before the
 * transaction, the transaction creates it and closes it again after the
 * commit (its rent returns to the owner); an existing one, and any wSOL it
 * holds, is left as it is.
 */
export async function buildCommitTx(conn: Connection, owner: PublicKey, launch: PublicKey, lamports: bigint, opts: CommitOptions = {}): Promise<Transaction> {
  if (!isU64(lamports) || lamports === 0n) throw new RangeError("lamports must be a positive u64");
  const l = await liveLaunch(conn, launch);
  if (l.executed) throw new Error("the batch has already executed");
  const commit = await fetchCommit(conn, launch, owner);
  let tokenOwner: PublicKey;
  let refundOwner: PublicKey;
  if (commit !== null) {
    tokenOwner = opts.tokenOwner ?? commit.tokenOwner;
    refundOwner = opts.refundOwner ?? commit.refundOwner;
    if (!tokenOwner.equals(commit.tokenOwner) || !refundOwner.equals(commit.refundOwner)) {
      throw new Error(`InvalidPayoutOwner: this commit's payout owners are fixed (tokens to ${commit.tokenOwner.toBase58()}, refund to ${commit.refundOwner.toBase58()})`);
    }
  } else {
    tokenOwner = opts.tokenOwner ?? owner;
    refundOwner = opts.refundOwner ?? owner;
    const [tokenAcc, refundAcc] = await getAccounts(conn, [tokenOwner, refundOwner]);
    if (!tokenOwner.equals(owner) && !isPqVaultOf(tokenAcc ?? null, l.baseMint)) {
      throw new Error("InvalidPayoutOwner: the token owner must be the committer or an opened PQ vault of this launch's mint");
    }
    if (!refundOwner.equals(owner) && !isPqVaultOf(refundAcc ?? null, WSOL_MINT)) {
      throw new Error("InvalidPayoutOwner: the refund owner must be the committer or an opened PQ vault of wSOL");
    }
  }
  const ownerTotal = (commit?.amount ?? 0n) + lamports;
  if (l.batchWalletCap !== 0n && ownerTotal > l.batchWalletCap) throw new Error(`exceeds the per-wallet batch cap of ${l.batchWalletCap} lamports`);
  if (!tokenOwner.equals(owner)) {
    const record = await fetchPayoutVault(conn, launch, tokenOwner);
    const vaultTotal = (record?.committed ?? 0n) + lamports;
    if (l.batchWalletCap !== 0n && vaultTotal > l.batchWalletCap) {
      throw new Error(
        `CapExceeded: commits for the vault ${tokenOwner.toBase58()} are held to the per-wallet batch cap of ${l.batchWalletCap} lamports together (${record?.committed ?? 0n} already committed for it)`,
      );
    }
  }
  if (l.totalCommitted + lamports > U64_MAX) throw new RangeError("the batch total would overflow a u64");
  const ixs = commitInstructions(owner, launch, l.batchAuthority, lamports, tokenOwner, refundOwner, await wsolAtaExists(conn, owner));
  return finish(conn, owner, ixs, COMPUTE_UNITS.commit, opts);
}

/** `buildLaunchCommitBundleV1` options. */
export interface LaunchCommitBundleOptions extends ComputeBudgetOptions {
  /** Bigint unix seconds to check the attested window against (default: the cluster's Clock sysvar). */
  nowSecs?: bigint | undefined;
  /** Receives the commit's wSOL refund: the payer (default) or an opened PQ vault of wSOL. The tokens go to the payer (no vault of the new mint can exist yet). */
  refundOwner?: PublicKey | undefined;
  /** v1 loaded-accounts-data limit (default `LAUNCH_BUNDLE_LOADED_ACCOUNTS_BYTES`). */
  loadedAccountsDataSizeLimit?: number | undefined;
}

/**
 * `[launch, commit]` as one signed v1 transaction (SIMD-0385) with a
 * priority fee: with a compute-unit price this bundle no longer fits a
 * legacy transaction. For keepers and scripts: both `payer` (the launch
 * payer and the committer) and the fresh `baseMint` sign here, so pass
 * Keypairs; wallets sign the legacy `buildLaunchTx` alone. The compute limit
 * and the priority fee are v1 config words (`computeUnitPrice` in
 * micro-lamports per unit becomes the total `ceil(price * limit / 1e6)`).
 * Same refusals as `buildLaunchTx`, and the commit's per-wallet cap. Inside
 * the attested window the first `launch` to land wins.
 */
export async function buildLaunchCommitBundleV1(
  conn: Connection,
  payer: Keypair,
  launch: PublicKey,
  baseMint: Keypair,
  lamports: bigint,
  opts: LaunchCommitBundleOptions = {},
): Promise<{ tx: Uint8Array; signature: string; blockhash: string; lastValidBlockHeight: number; computeUnitLimit: number; priorityFeeLamports: bigint | null }> {
  if (!isU64(lamports) || lamports === 0n) throw new RangeError("lamports must be a positive u64");
  const owner = payer.publicKey;
  const { ix, launch: l } = await launchInstruction(conn, owner, launch, baseMint, opts.nowSecs);
  if (l.batchWalletCap !== 0n && lamports > l.batchWalletCap) throw new Error(`exceeds the per-wallet batch cap of ${l.batchWalletCap} lamports`);
  const refundOwner = opts.refundOwner ?? owner;
  if (!refundOwner.equals(owner) && !isPqVaultOf(await getAccount(conn, refundOwner), WSOL_MINT)) {
    throw new Error("InvalidPayoutOwner: the refund owner must be the payer or an opened PQ vault of wSOL");
  }
  const commitIxs = commitInstructions(owner, launch, l.batchAuthority, lamports, owner, refundOwner, await wsolAtaExists(conn, owner));
  const computeUnitLimit = computeUnitLimitOf(opts, COMPUTE_UNITS.launchCommitBundle);
  const fee = opts.computeUnitPrice !== undefined && opts.computeUnitPrice > 0n ? priorityFeeLamports(opts.computeUnitPrice, computeUnitLimit) : null;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = compileV1Message(owner, [ix, ...commitIxs], blockhash, {
    computeUnitLimit,
    loadedAccountsDataSizeLimit: opts.loadedAccountsDataSizeLimit ?? LAUNCH_BUNDLE_LOADED_ACCOUNTS_BYTES,
    ...(fee === null ? {} : { priorityFeeLamports: fee }),
  });
  const tx = signV1Message(message, [payer, baseMint]);
  return { tx, signature: encodeBase58(tx.subarray(message.bytes.length, message.bytes.length + 64)), blockhash, lastValidBlockHeight, computeUnitLimit, priorityFeeLamports: fee };
}

/**
 * `execute_batch`: one DBC buy of `min(total_committed, batch_total_cap)`
 * for the whole batch (permissionless, in the execution window), which then
 * ends the snipe shield at once (`end_snipe_shield` CPI: `hook_authority`,
 * the writable policy and the hook program). Keep it a top-level
 * instruction: a CPI'd `execute_batch` fails the snipe shield. The batch
 * must be the pool's first swap (`PoolAlreadyTraded` otherwise: the batch
 * can then only expire and refund every commit in full). Anyone can contend
 * the batch's write locks for the whole window: keepers should pay a
 * priority fee (`computeUnitPrice`) and keep the tight limit.
 */
export async function buildExecuteBatchTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const l = await liveLaunch(conn, launch);
  if (l.executed) throw new Error("the batch has already executed");
  if (l.totalCommitted === 0n) throw new Error("nothing was committed to the batch");
  const pool = ownedBy(await getAccount(conn, l.pool), PROGRAM_IDS.dbc, "DBC pool");
  if (pool === null) throw new Error(`the launch's DBC pool ${l.pool.toBase58()} does not exist`);
  if (decodeDbcTransferHookPool(pool.data).poolState.hasSwap !== 0) {
    throw new Error("the pool was traded before the batch (PoolAlreadyTraded): the batch cannot execute; after the execution window every commit is refunded in full");
  }
  const ix = buildInstruction(
    launchpad(),
    PROGRAM_IDS.launchpad,
    "execute_batch",
    {
      payer,
      launch,
      batchAuthority: l.batchAuthority,
      dbcConfig: l.dbcConfig,
      pool: l.pool,
      baseVault: dbcTokenVaultAddress(l.baseMint, l.pool),
      quoteVault: dbcTokenVaultAddress(WSOL_MINT, l.pool),
      baseMint: l.baseMint,
      batchQuoteEscrow: wsolAta(l.batchAuthority),
      batchBaseEscrow: associatedTokenAddress(l.batchAuthority, l.baseMint, T22),
      hookAuthority: hookAuthorityAddress(),
      policy: hookPolicyAddress(l.baseMint),
    },
    {},
    noisedHookAccounts(l.baseMint),
  );
  return finish(conn, payer, [ix], COMPUTE_UNITS.executeBatch, opts);
}

/**
 * `claim`: pays one commit (tokens + unspent wSOL after execution, or a full
 * refund after expiry) to the payout owners its first commit fixed: tokens
 * to ATA(token owner, base mint), the refund to ATA(refund owner, wSOL),
 * created if missing (a PQ vault's are its own token accounts).
 * Permissionless; `payer` pays for missing ATAs. Only the accounts the
 * payout needs are passed. When the refund owner claims for itself
 * (`payer` = refund owner) and its wSOL ATA does not exist before the
 * transaction, the claim creates it and the transaction closes it again, so
 * the refund arrives as SOL; otherwise the refund stays wSOL in that
 * account (nobody else can close it).
 */
export async function buildClaimTx(conn: Connection, payer: PublicKey, launch: PublicKey, owner: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const l = await liveLaunch(conn, launch);
  const commit = await fetchCommit(conn, launch, owner);
  if (commit === null) throw new Error("this owner has no commit in the batch");
  if (commit.claimed) throw new Error("this commit has already been claimed");
  let tokens = 0n;
  let refund = commit.amount;
  if (l.executed) {
    const share = batchShare(commit.amount, l.totalCommitted, l.quoteSpent, l.tokensOut);
    if (share === null) throw new Error("inconsistent batch accounting");
    tokens = share.tokens;
    refund = share.refund;
  }
  let remaining: AccountMeta[] = [];
  if (tokens > 0n) {
    const mintAcc = await getAccount(conn, l.baseMint);
    if (mintAcc === null) throw new Error("base mint does not exist");
    if (activeHookProgram(parseMint(mintAcc.owner, mintAcc.data)) !== null) remaining = noisedHookAccounts(l.baseMint);
  }
  const ix = buildInstruction(
    launchpad(),
    PROGRAM_IDS.launchpad,
    "claim",
    {
      payer,
      launch,
      commit: commit.publicKey,
      tokenOwner: commit.tokenOwner,
      refundOwner: commit.refundOwner,
      batchAuthority: l.batchAuthority,
      baseMint: l.baseMint,
      batchQuoteEscrow: wsolAta(l.batchAuthority),
      batchBaseEscrow: tokens > 0n ? associatedTokenAddress(l.batchAuthority, l.baseMint, T22) : null,
      refundOwnerAta: refund > 0n ? wsolAta(commit.refundOwner) : null,
      tokenOwnerAta: tokens > 0n ? associatedTokenAddress(commit.tokenOwner, l.baseMint, T22) : null,
    },
    { owner },
    remaining,
  );
  const ixs: TransactionInstruction[] = [ix];
  if (payer.equals(commit.refundOwner) && refund > 0n && !(await wsolAtaExists(conn, commit.refundOwner))) ixs.push(closeWsolAta(commit.refundOwner));
  return finish(conn, payer, ixs, COMPUTE_UNITS.claim, opts);
}

// ------------------------------------------------------------------- fees ---

/** `claim_fees`: DBC partner trading fees (wSOL) into the launch authority's wSOL ATA. */
export async function buildClaimFeesTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const l = await liveLaunch(conn, launch);
  const ix = buildInstruction(launchpad(), PROGRAM_IDS.launchpad, "claim_fees", {
    payer,
    launch,
    launchAuthority: l.launchAuthority,
    dbcConfig: l.dbcConfig,
    pool: l.pool,
    baseVault: dbcTokenVaultAddress(l.baseMint, l.pool),
    quoteVault: dbcTokenVaultAddress(WSOL_MINT, l.pool),
    baseMint: l.baseMint,
    authorityBaseAta: associatedTokenAddress(l.launchAuthority, l.baseMint, T22),
    authorityQuoteAta: wsolAta(l.launchAuthority),
  });
  return finish(conn, payer, [ix], COMPUTE_UNITS.claimFees, opts);
}

/** `claim_surplus`: DBC partner and creator surplus after the curve completes. */
export async function buildClaimSurplusTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const l = await liveLaunch(conn, launch);
  const ix = buildInstruction(launchpad(), PROGRAM_IDS.launchpad, "claim_surplus", {
    payer,
    launch,
    launchAuthority: l.launchAuthority,
    dbcConfig: l.dbcConfig,
    pool: l.pool,
    quoteVault: dbcTokenVaultAddress(WSOL_MINT, l.pool),
    authorityQuoteAta: wsolAta(l.launchAuthority),
  });
  return finish(conn, payer, [ix], COMPUTE_UNITS.claimFees, opts);
}

export interface LaunchLpPosition {
  position: PublicKey;
  positionNftAccount: PublicKey;
  pool: PublicKey;
  state: DammPosition;
  poolState: DammPool;
  /** Fees claimable now (DAMM v2 `update_fee` arithmetic). */
  pendingA: bigint;
  pendingB: bigint;
}

/** DAMM v2 fees a position can claim now: pending + liquidity * (pool - checkpoint) >> 128. */
export function pendingPositionFees(pool: DammPool, position: DammPosition): { a: bigint; b: bigint } {
  const liquidity = position.unlockedLiquidity + position.vestedLiquidity + position.permanentLockedLiquidity;
  const delta = (perLiquidity: Uint8Array, checkpoint: Uint8Array): bigint => {
    const d = u256le(perLiquidity) - u256le(checkpoint);
    return d > 0n ? (liquidity * d) >> 128n : 0n;
  };
  return {
    a: position.feeAPending + delta(pool.feeAPerLiquidity, position.feeAPerTokenCheckpoint),
    b: position.feeBPending + delta(pool.feeBPerLiquidity, position.feeBPerTokenCheckpoint),
  };
}

/**
 * DAMM v2 positions whose NFT the launch authority holds, in pools of
 * (base mint, wSOL). Reads the launch authority's Token-2022 accounts.
 */
export async function findLaunchLpPositions(conn: Connection, launch: Pick<LaunchAccount, "launchAuthority" | "baseMint">): Promise<LaunchLpPosition[]> {
  const res = await conn.getTokenAccountsByOwner(launch.launchAuthority, { programId: T22 }, "confirmed");
  const nfts: { account: PublicKey; mint: PublicKey }[] = [];
  for (const { pubkey, account } of res.value) {
    try {
      const t = parseTokenAccount(account.owner, new Uint8Array(account.data));
      if (t.amount === 1n && t.owner.equals(launch.launchAuthority)) nfts.push({ account: pubkey, mint: t.mint });
    } catch {
      // not a token account we can read: ignore
    }
  }
  if (nfts.length === 0) return [];
  const positions = await getAccounts(conn, nfts.map((n) => dammV2PositionAddress(n.mint)));
  const candidates: { nft: (typeof nfts)[number]; address: PublicKey; state: DammPosition }[] = [];
  nfts.forEach((nft, i) => {
    const acc = positions[i] ?? null;
    if (acc === null || !acc.owner.equals(PROGRAM_IDS.dammV2) || !idlCodecs().dammV2.hasDiscriminator("Position", acc.data)) return;
    const state = decodeDammPosition(acc.data);
    if (state.nftMint.equals(nft.mint)) candidates.push({ nft, address: acc.address, state });
  });
  const pools = await getAccounts(conn, candidates.map((c) => c.state.pool));
  const out: LaunchLpPosition[] = [];
  candidates.forEach((c, i) => {
    const pool = ownedBy(pools[i] ?? null, PROGRAM_IDS.dammV2, "DAMM v2 pool");
    if (pool === null || !idlCodecs().dammV2.hasDiscriminator("Pool", pool.data)) return;
    const poolState = decodeDammPool(pool.data);
    if (!poolState.tokenAMint.equals(launch.baseMint) || !poolState.tokenBMint.equals(WSOL_MINT)) return;
    const pending = pendingPositionFees(poolState, c.state);
    out.push({
      position: c.address,
      positionNftAccount: c.nft.account,
      pool: c.state.pool,
      state: c.state,
      poolState,
      pendingA: pending.a,
      pendingB: pending.b,
    });
  });
  return out;
}

/**
 * `claim_lp_fees`: one transaction per launch-authority DAMM v2 position
 * with claimable fees, positions with nothing claimable skipped. Anyone can
 * donate position NFTs to the launch authority; one transaction per
 * position keeps every one within the legacy size and compute limits
 * whatever was donated, and a failing position never blocks the others.
 * Throws if no position has fees.
 */
export async function buildClaimLpFeesTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction[]> {
  const l = await liveLaunch(conn, launch);
  const positions = (await findLaunchLpPositions(conn, l)).filter((p) => p.pendingA > 0n || p.pendingB > 0n);
  if (positions.length === 0) throw new Error("no launch-authority LP position has fees to claim");
  const out: Transaction[] = [];
  for (const p of positions) {
    const ix = buildInstruction(launchpad(), PROGRAM_IDS.launchpad, "claim_lp_fees", {
      payer,
      launch,
      launchAuthority: l.launchAuthority,
      dammPool: p.pool,
      position: p.position,
      positionNftAccount: p.positionNftAccount,
      tokenAVault: p.poolState.tokenAVault,
      tokenBVault: p.poolState.tokenBVault,
      baseMint: l.baseMint,
      authorityBaseAta: associatedTokenAddress(l.launchAuthority, l.baseMint, T22),
      authorityQuoteAta: wsolAta(l.launchAuthority),
    });
    out.push(await finish(conn, payer, [ix], COMPUTE_UNITS.claimLpFees, opts));
  }
  return out;
}

/**
 * `distribute`: routes the launch authority's wSOL (platform share to the
 * treasury, a wSOL PQ vault, then the stored recipients) and burns its base
 * tokens. Every share goes to ATA(wallet, wSOL), so a recipient that is a
 * wSOL PQ vault is paid into the vault's own token account. Remaining
 * accounts: `[wallet_i, wSOL ATA_i]` per stored recipient, in order.
 */
export async function buildDistributeTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const l = await liveLaunch(conn, launch);
  const remaining: AccountMeta[] = [];
  for (const r of activeRecipients(l)) {
    remaining.push({ pubkey: r.wallet, isSigner: false, isWritable: false });
    remaining.push({ pubkey: wsolAta(r.wallet), isSigner: false, isWritable: true });
  }
  const ix = buildInstruction(
    launchpad(),
    PROGRAM_IDS.launchpad,
    "distribute",
    {
      payer,
      launch,
      launchAuthority: l.launchAuthority,
      treasury: l.treasury,
      baseMint: l.baseMint,
      authorityQuoteAta: wsolAta(l.launchAuthority),
      authorityBaseAta: associatedTokenAddress(l.launchAuthority, l.baseMint, T22),
      treasuryQuoteAta: wsolAta(l.treasury),
    },
    {},
    remaining,
  );
  return finish(conn, payer, [ix], COMPUTE_UNITS.distribute, opts);
}

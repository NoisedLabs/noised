/**
 * MOCK implementation of the launch half of SPEC §4.1: reads and builders.
 * Same signatures and refusals as the SDK; `conn` is accepted and ignored.
 * Account lists come from the program IDLs by name, like the SDK's builders
 * (test/idl-layouts.test.ts checks them), and every builder starts with the
 * SDK's compute-budget instructions.
 */
import {
  associatedTokenAddress,
  attestationAddress,
  autopilotTreasuryAddress,
  batchShare,
  certificateAddress,
  commitAddress,
  COMPUTE_UNITS,
  DBC,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  extraAccountMetaListAddress,
  hookAuthorityAddress,
  hookPolicyAddress,
  inLaunchWindow,
  KNOWN_ACCOUNTS,
  launchPdas,
  launchPdasFromLaunch,
  MAX_SLIPPAGE_BPS,
  payoutVaultAddress,
  noisedHookAccounts,
  PROGRAM_IDS,
  rulesAccountFor,
  splitFees,
  tokenMetaAddress,
  validateLaunchParams,
  WSOL_MINT,
  type AttestationAccount,
  type CommitAccount,
  type CommitOptions,
  type ComputeBudgetOptions,
  type CreateLaunchOptions,
  type FeeRecipient,
  type LaunchAccount,
  type LaunchParamsInput,
  type LaunchTxOptions,
  type PayoutVaultAccount,
  type SwapOptions,
  type SwapQuote,
  type SwapSide,
  type SwapWarnings,
} from "@noisedlabs/sdk";
import { Keypair, PublicKey, SystemProgram, type Connection, type Transaction, type TransactionInstruction } from "@solana/web3.js";

import type { FeeRecipientsCheck } from "../backend/types";
import { bytesEqual } from "./bytes";
import { chain } from "./chain";
import { dammFail, dbcFail, findLaunch, guard, hookActive, launchFail, launchRulesProblem, liveLaunchByMint, payToFeeSink, RENT, runtime, SPL, T22, toLaunchAccount } from "./common";
import { goLive, newMockLaunch, tokenMetaAt } from "./fixtures";
import { budgetedTx, closeAccountIx, createAtaIdempotentIx, dammV2VaultAddress, namedIx, syncNativeIx, t22Ata, wsolAta } from "./ix";
import { applySwap, batchAmountIn, quote, simulateSwap } from "./market";
import { mockMint } from "./mints";
import { tokenRecipientCheck } from "./recipients";
import { register } from "./sim";
import { addSol, addTokens, commitKey, latency, nowSecs, payoutVaultKey, tokenAccountExists, tokenBalance, tokenKey, type MockState } from "./store";

const U64_MAX = (1n << 64n) - 1n;
const isU64 = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= U64_MAX;

/** `CloseAccount` of an owner's wSOL account: any wSOL in it returns to the owner as SOL, and the account is gone. */
function closeWsol(st: MockState, owner: PublicKey): void {
  const key = tokenKey(owner, WSOL_MINT);
  const held = st.tokens[key];
  if (held === undefined) return;
  delete st.tokens[key];
  addSol(st, owner, held);
}

/** Whether the simulated chain holds an opened PQ vault of `mint` at `owner` (the launchpad's `pq::is_vault_of`). */
function isVaultOf(s: MockState, owner: PublicKey, mint: PublicKey): boolean {
  return s.vaults[owner.toBase58()]?.mint.equals(mint) === true;
}

/** The launch, which must exist and be live (the SDK's `liveLaunch`). */
function liveLaunch(s: MockState, launch: PublicKey): ReturnType<typeof findLaunch> {
  const l = s.launches[launch.toBase58()];
  if (!l) throw new Error(`launch ${launch.toBase58()} does not exist`);
  if (l.state.status !== "live") throw new Error("launch is not live yet (call launch first)");
  return l;
}

// --------------------------------------------------------------- reads ---

export async function fetchLaunch(_conn: Connection, launch: PublicKey): Promise<LaunchAccount | null> {
  await latency("read");
  const l = chain().launches[launch.toBase58()];
  return l ? toLaunchAccount(l) : null;
}

export async function fetchLaunchByMint(_conn: Connection, mint: PublicKey): Promise<LaunchAccount | null> {
  await latency("read");
  const l = liveLaunchByMint(chain(), mint);
  return l ? toLaunchAccount(l) : null;
}

export async function listLaunches(_conn: Connection): Promise<LaunchAccount[]> {
  await latency("read");
  return Object.values(chain().launches)
    .map(toLaunchAccount)
    .sort((a, b) => Number(b.launchTs - a.launchTs));
}

export async function fetchCommit(_conn: Connection, launch: PublicKey, owner: PublicKey): Promise<CommitAccount | null> {
  await latency("read");
  const c = chain().commits[commitKey(launch, owner)];
  return c ? { ...c } : null;
}

/** The launch's attestation (`["attestation", launch]`), or null when none was written (an empty, burn-only one has `attested: false`). */
export async function fetchAttestation(_conn: Connection, launch: PublicKey): Promise<AttestationAccount | null> {
  await latency("read");
  const a = chain().attestations[launch.toBase58()];
  return a ? { ...a } : null;
}

/** What every commit naming `vault` as its token owner committed to `launch` (`["payout-vault", launch, vault]`), or null. */
export async function fetchPayoutVault(_conn: Connection, launch: PublicKey, vault: PublicKey): Promise<PayoutVaultAccount | null> {
  await latency("read");
  const committed = chain().payoutVaults[payoutVaultKey(launch, vault)];
  if (committed === undefined) return null;
  const [address, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("payout-vault"), launch.toBytes(), vault.toBytes()], PROGRAM_IDS.launchpad);
  return { publicKey: address, version: 1, bump, launch, vault, committed };
}

// ------------------------------------------------------ fee recipients ---

/**
 * Each fee recipient as `distribute` pays it (ATA(wallet, wSOL)), read from the simulated chain like the SDK reads the
 * cluster. The launch's own Autopilot treasury (`["treasury", launch]`, known before the launch exists) is accepted: its
 * wSOL account is spent by the token's autopilot, which only buys back and burns, burns, or pays its listed recipients.
 */
function feeRecipientsCheck(s: MockState, recipients: readonly Pick<FeeRecipient, "wallet">[], launch?: PublicKey): FeeRecipientsCheck {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const treasury = launch === undefined ? null : autopilotTreasuryAddress(launch);
  recipients.forEach((r, i) => {
    if (treasury !== null && r.wallet.equals(treasury)) return;
    const c = tokenRecipientCheck(s, r.wallet, WSOL_MINT, SPL);
    for (const reason of c.refusals) refusals.push(`recipients[${i}].wallet: ${reason}`);
    for (const w of c.warnings) warnings.push(`recipients[${i}].wallet: ${w}`);
  });
  return { ok: refusals.length === 0, refusals, warnings };
}

/** MOCK `checkFeeRecipients` (audit round 3, F3): the refusals `buildCreateLaunchTx` makes, before anything is built. */
export async function checkFeeRecipients(_conn: Connection, recipients: readonly Pick<FeeRecipient, "wallet">[]): Promise<FeeRecipientsCheck> {
  await latency("read");
  for (const r of recipients) if (r === null || typeof r !== "object" || !(r.wallet instanceof PublicKey)) throw new TypeError("every recipient needs a wallet PublicKey");
  return feeRecipientsCheck(chain(), recipients);
}

// ------------------------------------------------------------ builders ---

export async function buildCreateLaunchTx(
  _conn: Connection,
  creator: PublicKey,
  params: LaunchParamsInput,
  opts: CreateLaunchOptions = {},
): Promise<{ tx: Transaction; launch: PublicKey; launchSeed: Uint8Array; warnings: string[] }> {
  await latency("build");
  const launchSeed = opts.launchSeed ?? crypto.getRandomValues(new Uint8Array(32));
  const pdas = launchPdas(creator, launchSeed);
  // create_launch refuses exactly these two PDAs as fee recipients.
  const v = validateLaunchParams(params, [pdas.launchAuthority, pdas.batchAuthority]);
  if (!v.ok) throw new Error(`invalid launch parameters:\n${v.errors.join("\n")}`);
  const s = chain();
  if (s.launches[pdas.launch.toBase58()]) throw new Error("a launch with this seed already exists");
  const { refusals, warnings } = feeRecipientsCheck(s, params.recipients, pdas.launch);
  if (refusals.length > 0) throw new Error(`invalid fee recipients:\n${refusals.join("\n")}`);
  const onChain = { ...params };
  const ix = namedIx(
    "launchpad",
    "create_launch",
    { creator, protocol: pdas.protocol, launch: pdas.launch, launchAuthority: pdas.launchAuthority, dbcConfig: pdas.dbcConfig },
    { launchSeed, params: onChain },
  );
  const tx = budgetedTx(creator, [ix], COMPUTE_UNITS.createLaunch, opts);
  register(tx, {
    label: "CreateLaunch",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 61_000,
    payer: creator,
    rent: RENT.launchAndConfig,
    solOut: 0n,
    check: (st) => (st.launches[pdas.launch.toBase58()] ? runtime(`Allocate: account ${pdas.launch.toBase58()} already in use`) : null),
    apply: (st) => {
      const l = newMockLaunch({ launchSeed, creator, params: { ...onChain } });
      l.keeper = true;
      st.launches[l.address.toBase58()] = l;
    },
    logs: () => [`LaunchCreated { launch: ${pdas.launch.toBase58()}, creator: ${creator.toBase58()}, dbc_config: ${pdas.dbcConfig.toBase58()} }`],
  });
  return { tx, launch: pdas.launch, launchSeed, warnings };
}

/**
 * Why `launch` would refuse to open `launch` at `now` (the SDK's checks, in its order), or null. `RecordMissing`: the
 * metadata record the attestation names does not exist (the program's AccountNotInitialized on `token_meta`).
 */
function attestationProblem(s: MockState, launch: PublicKey, now: bigint): { error: string; code: "AttestationMismatch" | "NotLaunchWindow" | "WrongLaunchState" | "RecordMissing" } | null {
  const l = s.launches[launch.toBase58()];
  if (!l || l.state.status !== "configured") return { error: "launch has already been launched", code: "WrongLaunchState" };
  const a = s.attestations[launch.toBase58()];
  if (a === undefined) return { error: "the launch is not attested yet: its post-quantum identity must sign it first (attest_launch)", code: "AttestationMismatch" };
  if (!a.attested) {
    return {
      error: "the launch's attestation is empty: a signature only burned its leaf (wrong identity, metadata or window); the identity must attest again (AttestationMismatch)",
      code: "AttestationMismatch",
    };
  }
  if (!a.launch.equals(launch) || !bytesEqual(a.pqIdentity, l.state.pqIdentity)) {
    return { error: "the attestation does not belong to this launch or its identity (AttestationMismatch)", code: "AttestationMismatch" };
  }
  // The record the attestation names: `launch` takes the mint's name, symbol and uri from it.
  if (tokenMetaAt(s, launch, a.metadataHash) === null) {
    return { error: "the metadata record the attestation names does not exist (AccountNotInitialized): it was never published, or the RPC is behind", code: "RecordMissing" };
  }
  if (!inLaunchWindow(now, a.notBefore, a.notAfter)) {
    const when = (t: bigint): string => `${new Date(Number(t) * 1000).toISOString()} (${t})`;
    return { error: `NotLaunchWindow: the attested window runs from ${when(a.notBefore)} to ${when(a.notAfter)} inclusive; the cluster time is ${now}`, code: "NotLaunchWindow" };
  }
  return null;
}

/**
 * `launch`, permissionless inside the attested window like the SDK's: any
 * `payer`, no creator signature, no arguments (the mint's name, symbol and
 * uri come from the metadata record the attestation names, `token_meta`);
 * refused without an attested attestation, without that record, or outside
 * `notBefore..=notAfter`.
 */
export async function buildLaunchTx(_conn: Connection, payer: PublicKey, launch: PublicKey, baseMint: Keypair, opts: LaunchTxOptions = {}): Promise<{ tx: Transaction }> {
  await latency("build");
  if (opts.nowSecs !== undefined) inLaunchWindow(opts.nowSecs, 0n, 0n); // validates nowSecs like the SDK (TypeError / RangeError)
  const s = chain();
  const l = s.launches[launch.toBase58()];
  if (!l) throw new Error(`launch ${launch.toBase58()} does not exist`);
  const problem = attestationProblem(s, launch, opts.nowSecs ?? BigInt(nowSecs()));
  if (problem !== null) throw new Error(problem.error);
  const rulesProblem = launchRulesProblem(s, launch.toBase58());
  if (rulesProblem !== null) throw new Error(rulesProblem.kind === "runtime" ? rulesProblem.message : "the attested launch rules are not published yet");
  // No problem: the attestation exists, and `launch` passes the record it names.
  const attested = s.attestations[launch.toBase58()];
  if (attested === undefined) throw new Error("the launch is not attested yet");
  const mint = baseMint.publicKey;
  if (mockMint(s, mint) !== null) throw new Error("the base mint keypair must be fresh (its address is already in use)");
  const pdas = launchPdasFromLaunch(launch);
  const pool = dbcPoolAddress(pdas.dbcConfig, mint, WSOL_MINT);
  const ix = namedIx(
    "launchpad",
    "launch",
    {
      payer,
      launch,
      launchAuthority: pdas.launchAuthority,
      dbcConfig: pdas.dbcConfig,
      baseMint: mint,
      pool,
      baseVault: dbcTokenVaultAddress(mint, pool),
      quoteVault: dbcTokenVaultAddress(WSOL_MINT, pool),
      hookAuthority: hookAuthorityAddress(),
      extraAccountMetaList: extraAccountMetaListAddress(mint),
      policy: hookPolicyAddress(mint),
      certificate: certificateAddress(mint),
      attestation: attestationAddress(launch),
      tokenMeta: tokenMetaAddress(launch, attested.metadataHash),
      // The 23rd account (attestation v3): the rules record the attestation names, or the program id without rules.
      rules: rulesAccountFor(launch, attested.rulesHash),
    },
  );
  const tx = budgetedTx(payer, [ix], COMPUTE_UNITS.launch, opts);
  register(tx, {
    label: "Launch",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 188_000,
    payer,
    rent: RENT.launchAccounts,
    solOut: 0n,
    check: (st, now) => {
      const p = attestationProblem(st, launch, BigInt(now));
      // Attestation v3: the rules the creator's quantum key bound must be published before the launch opens.
      if (p === null) return launchRulesProblem(st, launch.toBase58());
      // Anchor checks `token_meta` before the handler runs.
      if (p.code === "RecordMissing") return runtime("AnchorError caused by account: token_meta. Error Code: AccountNotInitialized. Error Number: 3012. The metadata record the attestation names was never published.");
      return launchFail(p.code);
    },
    apply: (st, now) => {
      const cur = st.launches[launch.toBase58()];
      const attestation = st.attestations[launch.toBase58()];
      const record = attestation === undefined ? null : tokenMetaAt(st, launch, attestation.metadataHash);
      if (!cur || !attestation || !record) return;
      goLive(cur, { baseMint: mint, launchTs: now, record, attestation });
    },
    logs: () => [
      "Post-conditions: mint authority None, freeze authority None, metadata immutable and equal to the record, extension set exact, hook = Launch Guard; attestation matches (identity, record, window)",
      `Launched { launch: ${launch.toBase58()}, base_mint: ${mint.toBase58()}, pool: ${pool.toBase58()}, certificate: ${certificateAddress(mint).toBase58()} }`,
    ],
  });
  return { tx };
}

/**
 * `commit`, like the SDK's: the payout owners (tokens and refund) are the
 * committer or an opened PQ vault of the right mint, fixed by the first
 * commit (InvalidPayoutOwner); the per-wallet cap applies to the owner and,
 * when the tokens go to a vault, to everything committed for that vault
 * (CapExceeded). Above the total cap a commit is filled pro rata.
 */
export async function buildCommitTx(_conn: Connection, owner: PublicKey, launch: PublicKey, lamports: bigint, opts: CommitOptions = {}): Promise<Transaction> {
  await latency("build");
  if (!isU64(lamports) || lamports === 0n) throw new RangeError("lamports must be a positive u64");
  const s = chain();
  const current = liveLaunch(s, launch);
  if (current.state.executed) throw new Error("the batch has already executed");
  const existing = s.commits[commitKey(launch, owner)];
  let tokenOwner: PublicKey;
  let refundOwner: PublicKey;
  if (existing !== undefined) {
    tokenOwner = opts.tokenOwner ?? existing.tokenOwner;
    refundOwner = opts.refundOwner ?? existing.refundOwner;
    if (!tokenOwner.equals(existing.tokenOwner) || !refundOwner.equals(existing.refundOwner)) {
      throw new Error(`InvalidPayoutOwner: this commit's payout owners are fixed (tokens to ${existing.tokenOwner.toBase58()}, refund to ${existing.refundOwner.toBase58()})`);
    }
  } else {
    tokenOwner = opts.tokenOwner ?? owner;
    refundOwner = opts.refundOwner ?? owner;
    if (!tokenOwner.equals(owner) && !isVaultOf(s, tokenOwner, current.state.baseMint)) {
      throw new Error("InvalidPayoutOwner: the token owner must be the committer or an opened PQ vault of this launch's mint");
    }
    if (!refundOwner.equals(owner) && !isVaultOf(s, refundOwner, WSOL_MINT)) {
      throw new Error("InvalidPayoutOwner: the refund owner must be the committer or an opened PQ vault of wSOL");
    }
  }
  const cap = current.state.batchWalletCap;
  const ownerTotal = (existing?.amount ?? 0n) + lamports;
  if (cap !== 0n && ownerTotal > cap) throw new Error(`exceeds the per-wallet batch cap of ${cap} lamports`);
  const toVault = !tokenOwner.equals(owner);
  if (toVault) {
    const already = s.payoutVaults[payoutVaultKey(launch, tokenOwner)];
    if (cap !== 0n && (already ?? 0n) + lamports > cap) {
      throw new Error(
        `CapExceeded: commits for the vault ${tokenOwner.toBase58()} are held to the per-wallet batch cap of ${cap} lamports together (${already ?? 0n} already committed for it)`,
      );
    }
  }
  if (current.state.totalCommitted + lamports > U64_MAX) throw new RangeError("the batch total would overflow a u64");
  const pdas = launchPdasFromLaunch(launch);
  const commit = commitAddress(launch, owner);
  const ownerWsol = wsolAta(owner);
  const payoutVault = toVault ? payoutVaultAddress(launch, tokenOwner) : null;
  const ixs: TransactionInstruction[] = [
    createAtaIdempotentIx(owner, owner, WSOL_MINT, SPL),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ownerWsol, lamports }),
    syncNativeIx(ownerWsol),
    namedIx(
      "launchpad",
      "commit",
      { owner, launch, commit, batchAuthority: pdas.batchAuthority, ownerQuoteAccount: ownerWsol, batchQuoteEscrow: wsolAta(pdas.batchAuthority), tokenOwner, refundOwner, payoutVault },
      { amount: lamports },
    ),
  ];
  // Like the SDK: a wSOL account this transaction creates is closed again after the commit (it is empty
  // then; its rent returns); one that existed before is left as it is, with any wSOL it holds.
  if (!tokenAccountExists(s, owner, WSOL_MINT)) ixs.push(closeAccountIx(ownerWsol, owner, owner));
  const tx = budgetedTx(owner, ixs, COMPUTE_UNITS.commit, opts);
  const isNew = existing === undefined;
  register(tx, {
    label: "Commit",
    program: PROGRAM_IDS.launchpad,
    computeUnits: toVault ? 47_200 : 41_000,
    payer: owner,
    rent: (isNew ? RENT.commit : 0n) + (toVault && s.payoutVaults[payoutVaultKey(launch, tokenOwner)] === undefined ? RENT.payoutVault : 0n),
    solOut: lamports,
    check: (st, now) => {
      const l = st.launches[launch.toBase58()];
      if (!l || l.state.status !== "live") return launchFail("WrongLaunchState");
      if (BigInt(now) < l.state.launchTs || BigInt(now) >= l.state.commitEndTs) return launchFail("NotCommitWindow");
      const c = st.commits[commitKey(launch, owner)];
      if (c !== undefined && (!c.tokenOwner.equals(tokenOwner) || !c.refundOwner.equals(refundOwner))) return launchFail("InvalidPayoutOwner");
      if (!tokenOwner.equals(owner) && !isVaultOf(st, tokenOwner, l.state.baseMint)) return launchFail("InvalidPayoutOwner");
      if (!refundOwner.equals(owner) && !isVaultOf(st, refundOwner, WSOL_MINT)) return launchFail("InvalidPayoutOwner");
      // The total cap never refuses a commit (oversubscription is filled pro rata at claim).
      const capNow = l.state.batchWalletCap;
      if (capNow !== 0n && (c?.amount ?? 0n) + lamports > capNow) return launchFail("CapExceeded");
      if (toVault && capNow !== 0n && (st.payoutVaults[payoutVaultKey(launch, tokenOwner)] ?? 0n) + lamports > capNow) return launchFail("CapExceeded");
      return null;
    },
    apply: (st) => {
      const l = st.launches[launch.toBase58()];
      if (!l) return;
      addSol(st, owner, -lamports);
      const key = commitKey(launch, owner);
      const prev = st.commits[key];
      const bump = PublicKey.findProgramAddressSync([new TextEncoder().encode("commit"), launch.toBytes(), owner.toBytes()], PROGRAM_IDS.launchpad)[1];
      st.commits[key] = prev ? { ...prev, amount: prev.amount + lamports } : { publicKey: commit, version: 1, bump, launch, owner, amount: lamports, claimed: false, tokenOwner, refundOwner };
      if (toVault) {
        const pv = payoutVaultKey(launch, tokenOwner);
        st.payoutVaults[pv] = (st.payoutVaults[pv] ?? 0n) + lamports;
      }
      l.state.totalCommitted += lamports;
    },
    logs: (st) => {
      const l = st.launches[launch.toBase58()];
      const mine = st.commits[commitKey(launch, owner)]?.amount ?? 0n;
      return [
        `Committed { owner: ${owner.toBase58()}, amount: ${lamports}, owner_total: ${mine + lamports}, total_committed: ${(l?.state.totalCommitted ?? 0n) + lamports}, token_owner: ${tokenOwner.toBase58()}, refund_owner: ${refundOwner.toBase58()} }`,
      ];
    },
  });
  return tx;
}

export async function buildExecuteBatchTx(_conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  await latency("build");
  const s = chain();
  const l = liveLaunch(s, launch);
  if (l.state.executed) throw new Error("the batch has already executed");
  if (l.state.totalCommitted === 0n) throw new Error("nothing was committed to the batch");
  if (l.hasSwap) {
    throw new Error("the pool was traded before the batch (PoolAlreadyTraded): the batch cannot execute; after the execution window every commit is refunded in full");
  }
  const pdas = launchPdasFromLaunch(launch);
  const mint = l.state.baseMint;
  const ix = namedIx(
    "launchpad",
    "execute_batch",
    {
      payer,
      launch,
      batchAuthority: pdas.batchAuthority,
      dbcConfig: l.state.dbcConfig,
      pool: l.state.pool,
      baseVault: dbcTokenVaultAddress(mint, l.state.pool),
      quoteVault: dbcTokenVaultAddress(WSOL_MINT, l.state.pool),
      baseMint: mint,
      batchQuoteEscrow: wsolAta(pdas.batchAuthority),
      batchBaseEscrow: t22Ata(pdas.batchAuthority, mint),
      hookAuthority: hookAuthorityAddress(),
      policy: hookPolicyAddress(mint),
    },
    {},
    noisedHookAccounts(mint),
  );
  const tx = budgetedTx(payer, [ix], COMPUTE_UNITS.executeBatch, opts);
  register(tx, {
    label: "ExecuteBatch",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 152_000,
    payer,
    rent: tokenBalance(s, pdas.batchAuthority, mint) === 0n ? RENT.t22Account : 0n,
    solOut: 0n,
    check: (st, now) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur || cur.state.status !== "live") return launchFail("WrongLaunchState");
      if (cur.state.executed) return launchFail("AlreadyExecuted");
      if (BigInt(now) < cur.state.commitEndTs || BigInt(now) >= cur.state.executeEndTs) return launchFail("NotExecuteWindow");
      if (cur.state.totalCommitted === 0n) return launchFail("EmptyBatch");
      if (cur.hasSwap) return launchFail("PoolAlreadyTraded");
      return null;
    },
    apply: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur) return;
      // One buy of min(total_committed, batch_total_cap); claims refund the rest pro rata.
      const res = simulateSwap(cur, "buy", batchAmountIn(cur));
      applySwap(cur, "buy", res);
      cur.state.executed = true;
      cur.state.quoteSpent = res.amountInUsed;
      cur.state.tokensOut = res.amountOut;
      addTokens(st, pdas.batchAuthority, mint, res.amountOut);
    },
    logs: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur) return [];
      const r = simulateSwap(cur, "buy", batchAmountIn(cur));
      return [`BatchExecuted { total_committed: ${cur.state.totalCommitted}, quote_spent: ${r.amountInUsed}, tokens_out: ${r.amountOut} }`, "Snipe shield ended (end_snipe_shield)"];
    },
  });
  return tx;
}

/**
 * `claim`, like the SDK's: pays the commit's payout owners its first commit
 * fixed (tokens to ATA(token owner), the refund to ATA(refund owner, wSOL));
 * the refund owner claiming for itself unwraps the refund when the claim
 * creates its wSOL account.
 */
export async function buildClaimTx(_conn: Connection, payer: PublicKey, launch: PublicKey, owner: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  await latency("build");
  const s = chain();
  const l = liveLaunch(s, launch);
  const pdas = launchPdasFromLaunch(launch);
  const mint = l.state.baseMint;
  const commit = s.commits[commitKey(launch, owner)];
  if (!commit) throw new Error("this owner has no commit in the batch");
  if (commit.claimed) throw new Error("this commit has already been claimed");
  let tokens = 0n;
  let refund = commit.amount;
  if (l.state.executed) {
    const share = batchShare(commit.amount, l.state.totalCommitted, l.state.quoteSpent, l.state.tokensOut);
    if (!share) throw new Error("inconsistent batch accounting");
    tokens = share.tokens;
    refund = share.refund;
  }
  const { tokenOwner, refundOwner } = commit;
  const ix = namedIx(
    "launchpad",
    "claim",
    {
      payer,
      launch,
      commit: commit.publicKey,
      tokenOwner,
      refundOwner,
      batchAuthority: pdas.batchAuthority,
      baseMint: mint,
      batchQuoteEscrow: wsolAta(pdas.batchAuthority),
      batchBaseEscrow: tokens > 0n ? t22Ata(pdas.batchAuthority, mint) : null,
      refundOwnerAta: refund > 0n ? wsolAta(refundOwner) : null,
      tokenOwnerAta: tokens > 0n ? t22Ata(tokenOwner, mint) : null,
    },
    { owner },
    tokens > 0n && hookActive(l) ? noisedHookAccounts(mint) : [],
  );
  const ixs: TransactionInstruction[] = [ix];
  // Like the SDK: the refund owner claiming for itself unwraps the refund in the same transaction when the claim
  // creates its wSOL account; an existing one keeps the refund as wSOL, and a third-party cranker cannot close it.
  const wsolExisted = tokenAccountExists(s, refundOwner, WSOL_MINT);
  const unwraps = payer.equals(refundOwner) && refund > 0n && !wsolExisted;
  if (unwraps) ixs.push(closeAccountIx(wsolAta(refundOwner), refundOwner, refundOwner));
  /** The refund arrives as SOL when the transaction closes the wSOL account, else as wSOL in it. */
  const payRefund = (st: MockState, lamports: bigint): void => {
    if (unwraps) addSol(st, refundOwner, lamports);
    else if (lamports > 0n) addTokens(st, refundOwner, WSOL_MINT, lamports);
  };
  const tx = budgetedTx(payer, ixs, COMPUTE_UNITS.claim, opts);
  register(tx, {
    label: "Claim",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 58_000,
    payer,
    rent: (tokens > 0n && !tokenAccountExists(s, tokenOwner, mint) ? RENT.t22Account : 0n) + (refund > 0n && !wsolExisted && !unwraps ? RENT.splAccount : 0n),
    solOut: 0n,
    check: (st, now) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur || cur.state.status !== "live") return launchFail("WrongLaunchState");
      const c = st.commits[commitKey(launch, owner)];
      if (!c) return runtime("AnchorError caused by account: commit. Error Code: AccountNotInitialized. This wallet has no commit in this batch.");
      if (c.claimed) return launchFail("AlreadyClaimed");
      if (!cur.state.executed && BigInt(now) < cur.state.executeEndTs) return launchFail("BatchPending");
      return null;
    },
    apply: (st) => {
      const cur = st.launches[launch.toBase58()];
      const key = commitKey(launch, owner);
      const c = st.commits[key];
      if (!cur || !c) return;
      if (cur.state.executed) {
        const share = batchShare(c.amount, cur.state.totalCommitted, cur.state.quoteSpent, cur.state.tokensOut);
        if (!share) return;
        addTokens(st, pdas.batchAuthority, mint, -share.tokens);
        addTokens(st, c.tokenOwner, mint, share.tokens);
        payRefund(st, share.refund);
        cur.state.tokensClaimed += share.tokens;
        cur.state.quoteRefunded += share.refund;
      } else {
        payRefund(st, c.amount);
        cur.state.quoteRefunded += c.amount;
      }
      st.commits[key] = { ...c, claimed: true };
    },
    logs: (st) => {
      const cur = st.launches[launch.toBase58()];
      const c = st.commits[commitKey(launch, owner)];
      if (!cur || !c) return [];
      if (!cur.state.executed) return [`BatchClaimed { owner: ${owner.toBase58()}, tokens: 0, refund: ${c.amount}, expired: true }`];
      const share = batchShare(c.amount, cur.state.totalCommitted, cur.state.quoteSpent, cur.state.tokensOut);
      return [`BatchClaimed { owner: ${owner.toBase58()}, tokens: ${share?.tokens ?? 0n}, refund: ${share?.refund ?? 0n}, expired: false }`];
    },
  });
  return tx;
}

export async function buildClaimFeesTx(_conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  await latency("build");
  const s = chain();
  const l = liveLaunch(s, launch);
  const pdas = launchPdasFromLaunch(launch);
  const mint = l.state.baseMint;
  const ix = namedIx("launchpad", "claim_fees", {
    payer,
    launch,
    launchAuthority: pdas.launchAuthority,
    dbcConfig: l.state.dbcConfig,
    pool: l.state.pool,
    baseVault: dbcTokenVaultAddress(mint, l.state.pool),
    quoteVault: dbcTokenVaultAddress(WSOL_MINT, l.state.pool),
    baseMint: mint,
    authorityBaseAta: t22Ata(pdas.launchAuthority, mint),
    authorityQuoteAta: wsolAta(pdas.launchAuthority),
  });
  const tx = budgetedTx(payer, [ix], COMPUTE_UNITS.claimFees, opts);
  register(tx, {
    label: "ClaimFees",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 47_000,
    payer,
    rent: 0n,
    solOut: 0n,
    check: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur || cur.state.status !== "live") return launchFail("WrongLaunchState");
      if (cur.migrated) return dbcFail(6013);
      if (cur.feesClaimable === 0n) return launchFail("NothingToDo");
      return null;
    },
    apply: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur) return;
      cur.authorityQuote += cur.feesClaimable;
      cur.feesClaimable = 0n;
    },
    logs: (st) => {
      const cur = st.launches[launch.toBase58()];
      return cur ? [`FeesClaimed { launch: ${launch.toBase58()}, quote_amount: ${cur.feesClaimable}, surplus: false }`] : [];
    },
  });
  return tx;
}

/**
 * `claim_lp_fees`, like the SDK's: one transaction per launch-authority
 * DAMM v2 position with claimable fees (the simulated chain holds one
 * position per migrated launch); throws when none has any.
 */
export async function buildClaimLpFeesTx(_conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction[]> {
  await latency("build");
  const s = chain();
  const l = liveLaunch(s, launch);
  if (!l.migrated || l.dammPool === null || l.positionNftMint === null || (l.lpFeesQuote === 0n && l.lpFeesBase === 0n)) {
    throw new Error("no launch-authority LP position has fees to claim");
  }
  const pdas = launchPdasFromLaunch(launch);
  const mint = l.state.baseMint;
  const pool = l.dammPool;
  const nft = l.positionNftMint;
  const position = PublicKey.findProgramAddressSync([new TextEncoder().encode("position"), nft.toBytes()], PROGRAM_IDS.dammV2)[0];
  const nftAccount = PublicKey.findProgramAddressSync([new TextEncoder().encode("position_nft_account"), nft.toBytes()], PROGRAM_IDS.dammV2)[0];
  const ix = namedIx("launchpad", "claim_lp_fees", {
    payer,
    launch,
    launchAuthority: pdas.launchAuthority,
    dammPool: pool,
    position,
    positionNftAccount: nftAccount,
    tokenAVault: dammV2VaultAddress(mint, pool),
    tokenBVault: dammV2VaultAddress(WSOL_MINT, pool),
    baseMint: mint,
    authorityBaseAta: t22Ata(pdas.launchAuthority, mint),
    authorityQuoteAta: wsolAta(pdas.launchAuthority),
  });
  const tx = budgetedTx(payer, [ix], COMPUTE_UNITS.claimLpFees, opts);
  register(tx, {
    label: "ClaimLpFees",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 64_000,
    payer,
    rent: 0n,
    solOut: 0n,
    check: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur || !cur.migrated) return launchFail("WrongLaunchState");
      if (cur.lpFeesQuote === 0n && cur.lpFeesBase === 0n) return launchFail("NothingToDo");
      return null;
    },
    apply: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur) return;
      cur.authorityQuote += cur.lpFeesQuote;
      cur.authorityBase += cur.lpFeesBase;
      cur.lpFeesQuote = 0n;
      cur.lpFeesBase = 0n;
    },
    logs: (st) => {
      const cur = st.launches[launch.toBase58()];
      return cur ? [`LpFeesClaimed { launch: ${launch.toBase58()}, position: ${position.toBase58()}, base_amount: ${cur.lpFeesBase}, quote_amount: ${cur.lpFeesQuote} }`] : [];
    },
  });
  return [tx];
}

export async function buildDistributeTx(_conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  await latency("build");
  const s = chain();
  const l = liveLaunch(s, launch);
  const pdas = launchPdasFromLaunch(launch);
  const mint = l.state.baseMint;
  const recipients = l.state.recipients.slice(0, l.state.recipientCount);
  const ix = namedIx(
    "launchpad",
    "distribute",
    {
      payer,
      launch,
      launchAuthority: pdas.launchAuthority,
      treasury: l.state.treasury,
      baseMint: mint,
      authorityQuoteAta: wsolAta(pdas.launchAuthority),
      authorityBaseAta: t22Ata(pdas.launchAuthority, mint),
      treasuryQuoteAta: wsolAta(l.state.treasury),
    },
    {},
    // Remaining accounts: [wallet_i, wsol_ata_i] for every stored recipient, in order.
    recipients.flatMap((x) => [
      { pubkey: x.wallet, isSigner: false, isWritable: false },
      { pubkey: wsolAta(x.wallet), isSigner: false, isWritable: true },
    ]),
  );
  const tx = budgetedTx(payer, [ix], COMPUTE_UNITS.distribute, opts);
  register(tx, {
    label: "Distribute",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 71_000,
    payer,
    rent: 0n,
    solOut: 0n,
    check: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur || cur.state.status !== "live") return launchFail("WrongLaunchState");
      if (cur.authorityQuote === 0n && cur.authorityBase === 0n) return launchFail("NothingToDo");
      return null;
    },
    apply: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur) return;
      const split = splitFees(cur.authorityQuote, cur.state.platformFeeBps, recipients);
      if (split) {
        addTokens(st, cur.state.treasury, WSOL_MINT, split.platform);
        split.recipients.forEach((v, i) => {
          const rcp = recipients[i];
          // Every share goes to ATA(wallet, wSOL): a wSOL PQ vault recipient is paid into the vault's own token account,
          // and the launch's own Autopilot treasury into the treasury's wSOL account (what its autopilot spends).
          if (rcp && !payToFeeSink(st, launch.toBase58(), rcp.wallet, v)) addTokens(st, rcp.wallet, WSOL_MINT, v);
        });
      }
      cur.authorityQuote = 0n;
      cur.authorityBase = 0n;
    },
    logs: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur) return [];
      const split = splitFees(cur.authorityQuote, cur.state.platformFeeBps, recipients);
      const toRecipients = split ? split.recipients.reduce((a, b) => a + b, 0n) : 0n;
      return [`Distributed { platform_amount: ${split?.platform ?? 0n}, recipients_amount: ${toRecipients}, base_burned: ${cur.authorityBase} }`];
    },
  });
  return tx;
}

/**
 * Buy or sell, like the SDK's `buildSwapTx`: `opts.recipient` routes the
 * output to ATA(recipient, output mint) (buy straight into a PQ vault),
 * checked like `checkTokenRecipient` (refusals throw, warnings returned),
 * with the Launch Guard's cap on the receiving account and its transfer
 * rules as a warning for a recipient that is not the user.
 */
export async function buildSwapTx(
  _conn: Connection,
  user: PublicKey,
  mint: PublicKey,
  side: SwapSide,
  amountIn: bigint,
  slippageBps: number,
  opts: SwapOptions = {},
): Promise<{ tx: Transaction; quote: SwapQuote; warnings: SwapWarnings }> {
  await latency("build");
  if (side !== "buy" && side !== "sell") throw new RangeError('side must be "buy" or "sell"');
  if (!isU64(amountIn) || amountIn === 0n) throw new RangeError("amountIn must be a positive u64");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new RangeError(`slippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS}`);
  if (opts.recipient !== undefined && !(opts.recipient instanceof PublicKey)) throw new TypeError("recipient must be a PublicKey");
  const s = chain();
  const l = liveLaunchByMint(s, mint);
  if (!l) throw new Error("not a Noised launch: no certificate for this mint");
  if (l.curveComplete && !l.migrated) throw new Error("the bonding curve completed: trading resumes on Meteora DAMM v2 once anyone calls DBC's migration");
  const [outMint, outProgram] = side === "buy" ? [mint, T22] : [WSOL_MINT, SPL];
  const outOwner = opts.recipient ?? user;
  const toOther = !outOwner.equals(user);
  const warnings: SwapWarnings = [];
  if (toOther) {
    const check = tokenRecipientCheck(s, outOwner, outMint, outProgram);
    if (!check.ok) throw new Error(`refused swap recipient ${outOwner.toBase58()}:\n${check.refusals.join("\n")}`);
    warnings.push(...check.warnings);
  }
  const q = quote(l, side, amountIn, slippageBps);
  const now = BigInt(nowSecs());
  if (side === "buy" && !l.migrated && hookActive(l) && now < l.state.guardEndTs && toOther) {
    const until = new Date(Number(l.state.guardEndTs) * 1000).toISOString();
    warnings.push(
      l.state.p2pLocked
        ? `until ${until} the Launch Guard pauses wallet-to-wallet transfers: tokens bought into this account cannot leave it before then (a vault's release counts as a transfer)`
        : `until ${until} the Launch Guard caps every transfer out of this account at ${l.maxBuy === 0n ? "no limit" : `${l.maxBuy} base units`} (a vault's release counts as a transfer)`,
    );
  }
  const userBase = t22Ata(user, mint);
  const userWsol = wsolAta(user);
  const outAccount = associatedTokenAddress(outOwner, outMint, outProgram);
  const ixs: TransactionInstruction[] = [
    createAtaIdempotentIx(user, side === "buy" ? outOwner : user, mint, T22),
    createAtaIdempotentIx(user, side === "sell" ? outOwner : user, WSOL_MINT, SPL),
  ];
  if (side === "buy") ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: amountIn }), syncNativeIx(userWsol));
  const input = side === "buy" ? userWsol : userBase;
  const output = side === "buy" ? (toOther ? outAccount : userBase) : toOther ? outAccount : userWsol;
  const swapMode = side === "buy" ? DBC.SWAP_MODE_PARTIAL_FILL : DBC.SWAP_MODE_EXACT_IN;
  const params = { amount0: amountIn, amount1: q.minimumOut, swapMode };
  let venue: PublicKey;
  if (l.migrated && l.dammPool) {
    // DAMM v2 swap2: token A = base (Token-2022), token B = wSOL; the hook was revoked at graduation.
    venue = PROGRAM_IDS.dammV2;
    const pool = l.dammPool;
    ixs.push(
      namedIx(
        "dammV2",
        "swap2",
        {
          pool,
          inputTokenAccount: input,
          outputTokenAccount: output,
          tokenAVault: dammV2VaultAddress(mint, pool),
          tokenBVault: dammV2VaultAddress(WSOL_MINT, pool),
          tokenAMint: mint,
          tokenBMint: WSOL_MINT,
          payer: user,
          tokenAProgram: T22,
          tokenBProgram: SPL,
          referralTokenAccount: null,
          eventAuthority: KNOWN_ACCOUNTS.dammV2EventAuthority,
          program: PROGRAM_IDS.dammV2,
        },
        { _params: params },
      ),
    );
  } else {
    venue = PROGRAM_IDS.dbc;
    const active = hookActive(l);
    // While the Launch Guard is active DBC needs swap2_with_transfer_hook and the hook accounts.
    const hookAccounts = noisedHookAccounts(mint);
    const hookInfo = { slices: [{ accountsType: { kind: "TransferHookBase" }, length: hookAccounts.length }] };
    ixs.push(
      namedIx(
        "dbc",
        active ? "swap2_with_transfer_hook" : "swap2",
        {
          config: l.state.dbcConfig,
          pool: l.state.pool,
          inputTokenAccount: input,
          outputTokenAccount: output,
          baseVault: dbcTokenVaultAddress(mint, l.state.pool),
          quoteVault: dbcTokenVaultAddress(WSOL_MINT, l.state.pool),
          baseMint: mint,
          quoteMint: WSOL_MINT,
          payer: user,
          tokenBaseProgram: T22,
          tokenQuoteProgram: SPL,
          referralTokenAccount: null,
          eventAuthority: KNOWN_ACCOUNTS.dbcEventAuthority,
          program: PROGRAM_IDS.dbc,
        },
        active ? { params, transferHookAccountsInfo: hookInfo } : { params },
        active ? hookAccounts : [],
      ),
    );
  }
  // Meteora's DBC swap always closes the user's wSOL account afterwards; the SDK's DAMM v2 swap closes it only
  // when this transaction created it (an existing one keeps any wSOL, received wSOL included). A sell paid to
  // another owner leaves the user's wSOL account as it was (the SDK drops that close).
  const unwraps = !(side === "sell" && toOther) && (venue.equals(PROGRAM_IDS.dbc) || !tokenAccountExists(s, user, WSOL_MINT));
  if (unwraps) ixs.push(closeAccountIx(userWsol, user, user));
  const tx = budgetedTx(user, ixs, l.migrated ? 120_000 : 250_000);
  const viaToken = [T22];
  register(tx, {
    label: l.migrated ? "Swap2" : hookActive(l) ? "Swap2WithTransferHook" : "Swap2",
    program: venue,
    computeUnits: l.migrated ? 64_000 : 112_000,
    payer: user,
    rent: side === "buy" && !tokenAccountExists(s, outOwner, mint) ? RENT.t22Account : side === "sell" && toOther && !tokenAccountExists(s, outOwner, WSOL_MINT) ? RENT.splAccount : 0n,
    solOut: side === "buy" ? amountIn : 0n,
    check: (st, nowTs) => {
      const cur = liveLaunchByMint(st, mint);
      if (!cur) return runtime("AnchorError caused by account: pool. Error Code: AccountNotInitialized.");
      if (cur.curveComplete && !cur.migrated) return dbcFail(6013);
      if (cur.migrated && cur.dammStatus === "disabled") return dammFail(6003);
      if (side === "sell" && tokenBalance(st, user, mint) < amountIn) return runtime("Program log: Error: insufficient funds");
      const res = simulateSwap(cur, side, amountIn);
      if (side === "buy") {
        const refusal = guard(
          cur,
          nowTs,
          {
            amount: res.amountOut,
            isBuy: true,
            isSell: false,
            sourceOwner: KNOWN_ACCOUNTS.dbcPoolAuthority,
            destinationOwner: outOwner,
            destinationBalanceAfter: tokenBalance(st, outOwner, mint) + res.amountOut,
            // What custom launch rules read: the top-level program and how many top-level instructions the transaction has.
            topProgram: venue,
            txIxCount: tx.instructions.length,
          },
          viaToken,
        );
        if (refusal) return refusal;
      }
      if (res.amountOut === 0n || res.amountOut < q.minimumOut) return cur.migrated ? dammFail(6002) : dbcFail(6002);
      return null;
    },
    apply: (st) => {
      const cur = liveLaunchByMint(st, mint);
      if (!cur) return;
      const res = simulateSwap(cur, side, amountIn);
      applySwap(cur, side, res);
      if (side === "buy") {
        addSol(st, user, -res.amountInUsed);
        addTokens(st, outOwner, mint, res.amountOut);
      } else {
        addTokens(st, user, mint, -res.amountInUsed);
        if (toOther) addTokens(st, outOwner, WSOL_MINT, res.amountOut);
        else if (unwraps) addSol(st, user, res.amountOut);
        else addTokens(st, user, WSOL_MINT, res.amountOut);
      }
      if (unwraps) closeWsol(st, user);
    },
    logs: () => [
      side === "buy"
        ? `Swap: ${amountIn} lamports in (partial fill allowed), minimum ${q.minimumOut} base units out${toOther ? ` to ${outOwner.toBase58()}` : ""}`
        : `Swap: ${amountIn} base units in (exact in), minimum ${q.minimumOut} lamports out${toOther ? ` to ${outOwner.toBase58()}` : ""}`,
    ],
  });
  return { tx, quote: q, warnings };
}

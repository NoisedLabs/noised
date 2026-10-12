/**
 * `buildSwapTx`: buy or sell a Noised launch token.
 *
 * - While the bonding curve runs: Meteora DBC through Meteora's MIT-licensed
 *   SDK (`@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13), which quotes with
 *   the program's math and builds the hook-pool swap. Buys use PartialFill
 *   (an exact-in buy cannot cross the migration price). The Launch Guard's
 *   hook accounts the SDK resolved must be exactly the mint's four (meta
 *   list, policy, instructions sysvar, hook program); they are then put in
 *   the launchpad's canonical order. Rules the Launch Guard would enforce
 *   (snipe shield, max buy, max wallet) are checked first so a doomed
 *   transaction is never offered for signing.
 * - After graduation: the DAMM v2 pool DBC created, built from the vendored
 *   cp_amm IDL. The expected output comes from simulating the exact swap
 *   (the program's own math, no reimplementation); the slippage bound is
 *   then applied to it.
 *
 * Buy into a PQ vault (`recipient`): the output goes to ATA(recipient,
 * output mint), created by the user if missing, e.g. the deposit account of
 * an opened PQ vault of that mint. Both AMMs accept an output token account
 * of any owner (checked in Meteora's sources): DBC 0.2.1 `swap2` and
 * `swap2_with_transfer_hook` declare `output_token_account` as
 * `#[account(mut)] InterfaceAccount<TokenAccount>` with no owner or
 * authority constraint (`instructions/swap/ix_swap.rs`,
 * `ix_swap2_with_transfer_hook.rs`) and pay it with a pool-authority-signed
 * `transfer_checked` (`process_swap.rs`); DAMM v2 `swap` / `swap2` only
 * require it to be writable, initialized and owned by a token program
 * (`instructions/swap/ix_swap.rs` -> `utils/p_helper.rs`
 * `validate_mut_token_account`). Only the input account must belong to the
 * signer. While the Launch Guard runs, max-buy applies to the transfer and
 * max-wallet to the recipient's account; a vault is not exempt, and its
 * later `release` is a wallet-to-wallet transfer for the hook (p2p lock,
 * max-buy) until the guard ends. Recipients whose account nobody could move
 * are refused (`checkTokenRecipient`).
 */
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, VersionedTransaction, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";

import { bytesEqual, isU64 } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { DAMM_V2_MIGRATION_CONFIGS, DBC, KNOWN_ACCOUNTS, LAUNCH_GUARD, PROGRAM_IDS, WSOL_MINT } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { DAMM_POOL_STATUS_ENABLED, dammBaseFeeScheduler, decodeDammPool, type DammPool } from "../meteora/state.js";
import { associatedTokenAddress, dammV2PoolAddress, hookPolicyAddress, wsolAta } from "../pda.js";
import { computeUnitLimitOf, computeUnitPriceOf, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { explainTransactionError } from "../rpc/errors.js";
import { getAccount, getAccounts, ownedBy } from "../rpc/fetch.js";
import { hasImmutableOwner, parseMint, parseTokenAccount } from "../token/mint.js";
import { activeHookProgram, mutableOwnerRefusal, noisedHookAccounts } from "../token/hook.js";
import type { CertificateAccount, LaunchAccount, SwapQuote, SwapSide } from "../types.js";
import { fetchCertificate, fetchLaunch } from "./accounts.js";
import { findLaunchLpPositions } from "./builders.js";
import { checkTokenRecipient } from "./recipients.js";

/** Largest slippage tolerance accepted (50%): anything above is almost certainly a mistake. */
export const MAX_SLIPPAGE_BPS = 5_000;
const DAMM_RATE_LIMITER_MODE = 2;
const Q128 = 1n << 128n;

/** Shortfall of `expectedOut` against the pre-trade spot price, in bps (fees included). */
export function priceImpactBps(side: SwapSide, amountIn: bigint, expectedOut: bigint, sqrtPrice: bigint): number | null {
  if (sqrtPrice === 0n || amountIn === 0n) return null;
  const p2 = sqrtPrice * sqrtPrice; // quote/base in Q128
  const ideal = side === "buy" ? (amountIn * Q128) / p2 : (amountIn * p2) / Q128;
  if (ideal === 0n) return null;
  const shortfall = ideal > expectedOut ? ideal - expectedOut : 0n;
  return Number((shortfall * 10_000n) / ideal);
}

/** A BN field of a Meteora SDK result, as bigint; throws if it is missing. */
function bnField(obj: Record<string, unknown>, name: string): bigint {
  const v = obj[name] as { toString?: (radix?: number) => string } | undefined;
  if (v === undefined || v === null || typeof v.toString !== "function") throw new Error(`DBC quote has no ${name}`);
  const s = v.toString(10);
  if (!/^\d+$/.test(s)) throw new Error(`DBC quote field ${name} is not a non-negative integer`);
  return BigInt(s);
}

/** `SwapParameters2`: amount_0 u64, amount_1 u64, swap_mode u8. */
const SWAP_PARAMETERS2_LEN = 17;

/**
 * Put the Launch Guard's hook accounts of a DBC `swap2_with_transfer_hook`
 * in the launchpad's canonical order, after checking that they are exactly
 * the mint's four (one `TransferHookBase` slice; DBC looks them up by key).
 */
export function canonicalizeLaunchGuardAccounts(tx: Transaction, mint: PublicKey): void {
  const codec = idlCodecs().dbc;
  const def = codec.instruction("swap2_with_transfer_hook");
  const swaps = tx.instructions.filter((i) => i.programId.equals(PROGRAM_IDS.dbc));
  if (swaps.length !== 1) throw new Error("the swap transaction must hold exactly one DBC instruction");
  const ix = swaps[0]!;
  const data = Uint8Array.from(ix.data);
  if (!bytesEqual(data.subarray(0, 8), Uint8Array.from(def.discriminator))) throw new Error("the DBC instruction is not swap2_with_transfer_hook");
  const info = codec.decodeType<{ slices: { accountsType: { kind: string }; length: number }[] }>("TransferHookAccountsInfo", data.subarray(8 + SWAP_PARAMETERS2_LEN));
  const want = noisedHookAccounts(mint);
  const slice = info.slices[0];
  if (info.slices.length !== 1 || slice === undefined || slice.accountsType.kind !== "TransferHookBase" || slice.length !== LAUNCH_GUARD.HOOK_ACCOUNT_COUNT) {
    throw new Error(`Meteora's SDK did not resolve the Launch Guard's ${LAUNCH_GUARD.HOOK_ACCOUNT_COUNT} hook accounts (meta list, policy, instructions sysvar, hook program)`);
  }
  const start = ix.keys.length - slice.length;
  const got = ix.keys.slice(start);
  const same =
    start >= def.accounts.length &&
    got.every((k) => !k.isSigner && !k.isWritable) &&
    want.every((w) => got.some((g) => g.pubkey.equals(w.pubkey))) &&
    new Set(got.map((g) => g.pubkey.toBase58())).size === got.length;
  if (!same) throw new Error("Meteora's SDK resolved hook accounts that are not the Launch Guard's (meta list, policy, instructions sysvar, hook program)");
  ix.keys.splice(start, slice.length, ...want);
}

function checkPrograms(tx: Transaction, allowed: readonly PublicKey[]): void {
  for (const ix of tx.instructions) {
    if (!allowed.some((p) => p.equals(ix.programId))) throw new Error(`swap transaction contains an unexpected program ${ix.programId.toBase58()}`);
  }
}

async function finish(conn: Connection, tx: Transaction, feePayer: PublicKey): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/** The legacy packet limit (`LEGACY_MAX_TRANSACTION_SIZE`). */
const LEGACY_TX_LIMIT = 1_232;

/**
 * `buildSwapTx` options. The compute budget is opt-in: without
 * `computeUnitLimit` and `computeUnitPrice` the transaction is left as built
 * (no compute-unit default has been measured for swaps). With either, the
 * swap starts with SetComputeUnitLimit (only when `computeUnitLimit` is
 * given) and SetComputeUnitPrice (only when `computeUnitPrice` is given),
 * replacing any compute-budget instruction the Meteora SDK added; a limit
 * too low makes the swap fail, and a swap that no longer fits a legacy
 * transaction (hook accounts make swaps large) is refused.
 */
export interface SwapOptions extends ComputeBudgetOptions {
  /**
   * Who receives the output: ATA(recipient, output mint) instead of the
   * user's own (base mint for a buy, wSOL for a sell), created by the user
   * if missing. Typically an opened PQ vault of the output mint: the tokens
   * land in post-quantum custody without ever touching an Ed25519 wallet.
   * Refused: token accounts and mints, programs, vaults of another mint,
   * other vault-program accounts and off-curve addresses with no account.
   */
  recipient?: PublicKey | undefined;
}

/** Where the output goes. */
interface Output {
  /** The output token account's owner (the user or the recipient). */
  owner: PublicKey;
  mint: PublicKey;
  program: PublicKey;
  account: PublicKey;
}

/** Cautions about where a swap's output goes (empty for the user's own account). */
export type SwapWarnings = string[];

/**
 * The swap's output owner and the cautions to show: a recipient other than
 * the user is checked with `checkTokenRecipient` (refusals throw).
 */
async function swapOutput(conn: Connection, user: PublicKey, l: LaunchAccount, side: SwapSide, recipient: PublicKey | undefined): Promise<{ out: Output; warnings: SwapWarnings }> {
  const [mint, program] = side === "buy" ? [l.baseMint, KNOWN_ACCOUNTS.token2022] : [WSOL_MINT, KNOWN_ACCOUNTS.splToken];
  const owner = recipient ?? user;
  const out = { owner, mint, program, account: associatedTokenAddress(owner, mint, program) };
  if (owner.equals(user)) return { out, warnings: [] };
  const check = await checkTokenRecipient(conn, owner, mint, program);
  if (!check.ok) throw new Error(`refused swap recipient ${owner.toBase58()}:\n${check.refusals.join("\n")}`);
  return { out, warnings: check.warnings };
}

/** The Launch Guard's live rules (the policy; the batch may have ended the shield before the certificate's scheduled end). */
async function guardRules(conn: Connection, l: LaunchAccount, cert: CertificateAccount): Promise<{ shieldEnd: bigint; guardEnd: bigint; maxBuy: bigint; maxWallet: bigint; p2pLocked: boolean }> {
  const acc = ownedBy(await getAccount(conn, hookPolicyAddress(l.baseMint)), PROGRAM_IDS.hook, "Launch Guard policy");
  if (acc === null) return { shieldEnd: cert.snipeShieldEndTs, guardEnd: cert.guardEndTs, maxBuy: cert.maxBuy, maxWallet: cert.maxWallet, p2pLocked: cert.p2pLocked };
  const p = idlCodecs().hook.decodeAccount<{ mint: PublicKey; snipeShieldEndTs: bigint; guardEndTs: bigint; maxBuy: bigint; maxWallet: bigint; p2pLocked: boolean }>("HookPolicy", acc.data);
  if (!p.mint.equals(l.baseMint)) throw new Error("the Launch Guard policy belongs to another mint");
  return { shieldEnd: p.snipeShieldEndTs, guardEnd: p.guardEndTs, maxBuy: p.maxBuy, maxWallet: p.maxWallet, p2pLocked: p.p2pLocked };
}

/**
 * Buy or sell a Noised launch token. `opts.recipient` routes the output to
 * another owner's ATA (buy straight into a PQ vault). `warnings` are
 * cautions about the recipient to show before signing.
 */
export async function buildSwapTx(
  conn: Connection,
  user: PublicKey,
  mint: PublicKey,
  side: SwapSide,
  amountIn: bigint,
  slippageBps: number,
  opts: SwapOptions = {},
): Promise<{ tx: Transaction; quote: SwapQuote; warnings: SwapWarnings }> {
  if (side !== "buy" && side !== "sell") throw new RangeError('side must be "buy" or "sell"');
  if (!isU64(amountIn) || amountIn === 0n) throw new RangeError("amountIn must be a positive u64");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new RangeError(`slippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS}`);
  }
  if (opts.recipient !== undefined && !(opts.recipient instanceof PublicKey)) throw new TypeError("recipient must be a PublicKey");
  // The compute budget is checked before anything is read.
  if (opts.computeUnitLimit !== undefined) computeUnitLimitOf(opts, 0);
  computeUnitPriceOf(opts);
  const cert = await fetchCertificate(conn, mint);
  if (cert === null) throw new Error("not a Noised launch: no certificate for this mint");
  const l = await fetchLaunch(conn, cert.launch);
  if (l === null || !l.baseMint.equals(mint)) throw new Error("launch account missing or for another mint");
  const market = l.market;
  if (market === undefined) throw new Error("could not read the launch's pool");
  if (!market.migrated && market.curveComplete) {
    throw new Error("the bonding curve completed: trading resumes on Meteora DAMM v2 once anyone calls DBC's migration");
  }
  const { out, warnings } = await swapOutput(conn, user, l, side, opts.recipient);
  const built = market.migrated ? { ...(await dammSwap(conn, user, l, side, amountIn, slippageBps, out)), warnings } : await dbcSwap(conn, user, l, cert, side, amountIn, slippageBps, out, warnings);
  applyComputeBudget(built.tx, opts);
  return built;
}

/**
 * The caller's compute budget, first in `tx` (see `SwapOptions`); throws when the swap would no longer fit a legacy
 * transaction. Without options, `tx` is left exactly as built. Internal (not exported from the package root).
 */
export function applyComputeBudget(tx: Transaction, opts: ComputeBudgetOptions): void {
  if (opts.computeUnitLimit === undefined && opts.computeUnitPrice === undefined) return;
  const budget: TransactionInstruction[] = [];
  if (opts.computeUnitLimit !== undefined) budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimitOf(opts, 0) }));
  const price = computeUnitPriceOf(opts);
  if (price !== null) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  tx.instructions = [...budget, ...tx.instructions.filter((ix) => !ix.programId.equals(KNOWN_ACCOUNTS.computeBudget))];
  // The size from the compiled message (web3.js's own `serialize` would throw an unexplained "Transaction too large").
  const message = tx.compileMessage();
  const signatures = message.header.numRequiredSignatures;
  const size = (signatures < 0x80 ? 1 : 2) + 64 * signatures + message.serialize().length;
  if (size > LEGACY_TX_LIMIT) {
    throw new Error(`the swap with its compute-budget instructions is ${size} bytes, over the ${LEGACY_TX_LIMIT}-byte legacy limit: drop computeUnitLimit (keep only the priority fee) or swap without them`);
  }
}

/**
 * Point a Meteora-SDK-built DBC swap at `out.account` instead of the user's
 * own ATA: the DBC instruction's `output_token_account`, the SDK's create of
 * the user's output ATA (replaced by an idempotent create of the
 * recipient's, paid by the user) and, when the SDK created the user's wSOL
 * output only to close it after a sell, that close.
 */
function redirectDbcOutput(tx: Transaction, user: PublicKey, out: Output): void {
  const codec = idlCodecs().dbc;
  const userOut = associatedTokenAddress(user, out.mint, out.program);
  if (userOut.equals(out.account)) return;
  const swaps = tx.instructions.filter((i) => i.programId.equals(PROGRAM_IDS.dbc));
  if (swaps.length !== 1) throw new Error("the swap transaction must hold exactly one DBC instruction");
  const swap = swaps[0]!;
  const def = codec.idl.instructions.find((d) => bytesEqual(Uint8Array.from(swap.data.subarray(0, 8)), Uint8Array.from(d.discriminator)));
  if (def === undefined || !["swap", "swap2", "swap2_with_transfer_hook"].includes(def.name)) throw new Error("the DBC instruction is not a swap");
  const index = def.accounts.findIndex((a) => a.name === "output_token_account");
  const meta = swap.keys[index];
  if (meta === undefined || !meta.pubkey.equals(userOut) || !meta.isWritable) throw new Error("Meteora's SDK did not use the user's output account");
  swap.keys[index] = { pubkey: out.account, isSigner: false, isWritable: true };
  const createRecipient = createAssociatedTokenAccountIdempotentInstruction(user, out.account, out.owner, out.mint, out.program);
  const isCreateOf = (ix: TransactionInstruction, ata: PublicKey): boolean => ix.programId.equals(KNOWN_ACCOUNTS.associatedToken) && ix.keys[1]?.pubkey.equals(ata) === true;
  const created = tx.instructions.findIndex((ix) => isCreateOf(ix, userOut));
  if (created >= 0) tx.instructions.splice(created, 1, createRecipient);
  else tx.instructions.splice(tx.instructions.indexOf(swap), 0, createRecipient);
  if (created >= 0 && out.mint.equals(WSOL_MINT)) {
    // The SDK unwraps by closing the user's wSOL ATA, which no longer exists.
    const close = tx.instructions.findIndex((ix) => ix.programId.equals(KNOWN_ACCOUNTS.splToken) && ix.data[0] === 9 && ix.keys[0]?.pubkey.equals(userOut) === true);
    if (close >= 0) tx.instructions.splice(close, 1);
  }
}

async function dbcSwap(
  conn: Connection,
  user: PublicKey,
  l: LaunchAccount,
  cert: CertificateAccount,
  side: SwapSide,
  amountIn: bigint,
  slippageBps: number,
  out: Output,
  warnings: SwapWarnings,
): Promise<{ tx: Transaction; quote: SwapQuote; warnings: SwapWarnings }> {
  const sdk = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  // Under plain Node (ESM importing CommonJS) BN is only on the default export; bundlers expose it as a named export.
  const anchor = (await import("@coral-xyz/anchor")) as unknown as { BN?: typeof import("@coral-xyz/anchor").BN; default?: { BN?: typeof import("@coral-xyz/anchor").BN } };
  const BN = anchor.BN ?? anchor.default?.BN;
  if (BN === undefined) throw new Error("@coral-xyz/anchor did not provide BN");
  const client = new sdk.DynamicBondingCurveClient(conn, "confirmed");
  const virtualPool = await client.state.getPool(l.pool);
  const config = await client.state.getPoolConfig(l.dbcConfig);
  if (virtualPool === null || config === null) throw new Error("DBC pool or config not found");
  if (!virtualPool.poolState.baseMint.equals(l.baseMint) || !virtualPool.poolState.config.equals(l.dbcConfig)) {
    throw new Error("DBC pool does not belong to this launch");
  }
  const now = BigInt((await sdk.getCurrentPoint(conn, config.activationType)).toString());
  const swapBaseForQuote = side === "sell";
  const swapMode = side === "buy" ? sdk.SwapMode.PartialFill : sdk.SwapMode.ExactIn;
  const raw = client.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote,
    swapMode,
    amountIn: new BN(amountIn.toString()),
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: new BN(now.toString()),
  }) as unknown as Record<string, unknown>;
  const q = {
    outputAmount: bnField(raw, "outputAmount"),
    minimumAmountOut: bnField(raw, "minimumAmountOut"),
    tradingFee: bnField(raw, "tradingFee"),
    protocolFee: bnField(raw, "protocolFee"),
    referralFee: bnField(raw, "referralFee"),
    includedFeeInputAmount: bnField(raw, "includedFeeInputAmount"),
  };
  const expectedOut = q.outputAmount;
  const minimumOut = q.minimumAmountOut;
  if (expectedOut === 0n) throw new Error("this swap would return nothing");

  const rules = await guardRules(conn, l, cert);
  if (side === "buy") {
    if (now < rules.shieldEnd) {
      throw new Error(`buying opens at ${new Date(Number(rules.shieldEnd) * 1000).toISOString()} at the latest, or as soon as the fair-open batch executes (the Launch Guard refuses earlier buys)`);
    }
    if (now < rules.guardEnd) {
      if (rules.maxBuy !== 0n && expectedOut > rules.maxBuy) throw new Error(`the Launch Guard caps one buy at ${rules.maxBuy} base units until the guard ends`);
      // The account that receives the tokens (a recipient's, a vault's); one the swap creates is an ATA, whose owner is fixed.
      const acc = await getAccount(conn, out.account);
      const exists = acc !== null && acc.data.length > 0;
      // Audit round 3 F2 (MutableOwner 6010): an account whose owner can be reassigned is refused while the guard is on.
      if (exists && !hasImmutableOwner(acc.data)) throw new Error(`the receiving token account ${out.account.toBase58()} cannot receive this buy: ${mutableOwnerRefusal(rules.guardEnd)}`);
      if (rules.maxWallet !== 0n) {
        const held = exists ? parseTokenAccount(acc.owner, acc.data).amount : 0n;
        if (held + expectedOut > rules.maxWallet) throw new Error(`the Launch Guard caps the receiving account at ${rules.maxWallet} base units until the guard ends`);
      }
      if (!out.owner.equals(user)) {
        const until = new Date(Number(rules.guardEnd) * 1000).toISOString();
        warnings.push(
          rules.p2pLocked
            ? `until ${until} the Launch Guard pauses wallet-to-wallet transfers: tokens bought into this account cannot leave it before then (a vault's release counts as a transfer)`
            : `until ${until} the Launch Guard caps every transfer out of this account at ${rules.maxBuy === 0n ? "no limit" : `${rules.maxBuy} base units`} (a vault's release counts as a transfer)`,
        );
      }
    }
  }

  const mintAcc = await getAccount(conn, l.baseMint);
  if (mintAcc === null) throw new Error("base mint does not exist");
  const hookProgram = activeHookProgram(parseMint(mintAcc.owner, mintAcc.data));
  const hookActive = hookProgram !== null;
  const params = {
    pool: l.pool,
    swapBaseForQuote,
    swapMode,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(minimumOut.toString()),
    owner: user,
    payer: user,
    referralTokenAccount: null,
  } as Parameters<typeof client.pool.swap2>[0];
  const tx = hookActive ? await client.pool.swap2WithTransferHook(params) : await client.pool.swap2(params);
  checkPrograms(tx, [PROGRAM_IDS.dbc, KNOWN_ACCOUNTS.splToken, KNOWN_ACCOUNTS.token2022, KNOWN_ACCOUNTS.associatedToken, KNOWN_ACCOUNTS.system, KNOWN_ACCOUNTS.computeBudget]);
  if (hookProgram !== null && hookProgram.equals(PROGRAM_IDS.hook)) canonicalizeLaunchGuardAccounts(tx, l.baseMint);
  redirectDbcOutput(tx, user, out);

  const feeAmount = q.tradingFee + q.protocolFee + q.referralFee;
  const feeBase = side === "buy" ? q.includedFeeInputAmount : expectedOut + feeAmount;
  const quote: SwapQuote = {
    side,
    venue: "dbc",
    amountIn,
    expectedOut,
    minimumOut,
    feeAmount,
    feeBps: feeBase === 0n ? null : Number((feeAmount * 10_000n) / feeBase),
    priceImpactBps: priceImpactBps(side, side === "buy" ? q.includedFeeInputAmount : amountIn, expectedOut, l.market!.sqrtPrice),
    method: "dbc-sdk",
  };
  return { tx: await finish(conn, tx, user), quote, warnings };
}

/** The DBC-migrated DAMM v2 pool of a launch: the canonical config PDA, else the launch authority's position. */
async function dammPoolOf(conn: Connection, l: LaunchAccount): Promise<{ address: PublicKey; pool: DammPool }> {
  const canonical = DAMM_V2_MIGRATION_CONFIGS[l.migrationFeeOption];
  const candidates: PublicKey[] = [];
  if (canonical !== undefined) candidates.push(dammV2PoolAddress(canonical, l.baseMint, WSOL_MINT));
  if (candidates.length > 0) {
    const acc = ownedBy(await getAccount(conn, candidates[0]!), PROGRAM_IDS.dammV2, "DAMM v2 pool");
    if (acc !== null) return { address: candidates[0]!, pool: decodeDammPool(acc.data) };
  }
  const positions = await findLaunchLpPositions(conn, l);
  const main = positions.find((p) => p.poolState.creator.equals(KNOWN_ACCOUNTS.dbcPoolAuthority));
  if (main === undefined) throw new Error("could not find the DAMM v2 pool of this launch");
  return { address: main.pool, pool: main.poolState };
}

async function dammSwap(
  conn: Connection,
  user: PublicKey,
  l: LaunchAccount,
  side: SwapSide,
  amountIn: bigint,
  slippageBps: number,
  out: Output,
): Promise<{ tx: Transaction; quote: SwapQuote }> {
  const { address, pool } = await dammPoolOf(conn, l);
  if (!pool.tokenAMint.equals(l.baseMint) || !pool.tokenBMint.equals(WSOL_MINT)) throw new Error("DAMM v2 pool mints are not (base, wSOL)");
  if (!pool.creator.equals(KNOWN_ACCOUNTS.dbcPoolAuthority)) throw new Error("DAMM v2 pool was not created by DBC's migration");
  if (pool.poolStatus !== DAMM_POOL_STATUS_ENABLED) throw new Error("a DAMM v2 operator disabled this pool: swaps are stopped");

  const userBase = associatedTokenAddress(user, l.baseMint, KNOWN_ACCOUNTS.token2022);
  const userWsol = wsolAta(user);
  // The output may belong to a recipient (DAMM v2 accepts any initialized token account there).
  const input = side === "buy" ? userWsol : userBase;
  const output = out.account;
  const [wsolAcc, outputAcc] = await getAccounts(conn, [userWsol, output]);
  const wsolExisted = wsolAcc !== null && wsolAcc !== undefined && wsolAcc.data.length > 0;
  const outBefore = outputAcc === null || outputAcc === undefined || outputAcc.data.length === 0 ? 0n : parseTokenAccount(outputAcc.owner, outputAcc.data).amount;

  const createOutput = createAssociatedTokenAccountIdempotentInstruction(user, output, out.owner, out.mint, out.program);
  const pre: TransactionInstruction[] =
    side === "buy"
      ? [
          createOutput,
          createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, WSOL_MINT, KNOWN_ACCOUNTS.splToken),
          SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: amountIn }),
          createSyncNativeInstruction(userWsol, KNOWN_ACCOUNTS.splToken),
        ]
      : [createAssociatedTokenAccountIdempotentInstruction(user, userBase, user, l.baseMint, KNOWN_ACCOUNTS.token2022), createOutput];
  const remaining: AccountMeta[] = [];
  if (dammBaseFeeScheduler(pool).baseFeeMode === DAMM_RATE_LIMITER_MODE) {
    remaining.push({ pubkey: KNOWN_ACCOUNTS.sysvarInstructions, isSigner: false, isWritable: false });
  }
  const swapIx = (minimumOut: bigint): TransactionInstruction =>
    buildInstruction(
      idlCodecs().dammV2,
      PROGRAM_IDS.dammV2,
      "swap2",
      {
        pool: address,
        inputTokenAccount: input,
        outputTokenAccount: output,
        tokenAVault: pool.tokenAVault,
        tokenBVault: pool.tokenBVault,
        tokenAMint: l.baseMint,
        tokenBMint: WSOL_MINT,
        payer: user,
        tokenAProgram: KNOWN_ACCOUNTS.token2022,
        tokenBProgram: KNOWN_ACCOUNTS.splToken,
        referralTokenAccount: null,
        eventAuthority: KNOWN_ACCOUNTS.dammV2EventAuthority,
        program: PROGRAM_IDS.dammV2,
      },
      { _params: { amount0: amountIn, amount1: minimumOut, swapMode: DBC.SWAP_MODE_EXACT_IN } },
      remaining,
    );

  // Quote: simulate the exact swap with no minimum and read the output account afterwards.
  const probe = await finish(conn, new Transaction().add(...pre, swapIx(0n)), user);
  const sim = await conn.simulateTransaction(new VersionedTransaction(probe.compileMessage()), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [output.toBase58()] },
  });
  if (sim.value.err !== null) {
    throw new Error(`swap simulation failed: ${explainTransactionError(sim.value.err, sim.value.logs ?? []).error}`);
  }
  const post = sim.value.accounts?.[0];
  if (post === null || post === undefined) throw new Error("simulation did not return the output account");
  const encoded = post.data[0];
  if (encoded === undefined) throw new Error("simulation returned no account data");
  const postData = Uint8Array.from(Buffer.from(encoded, "base64"));
  const outAfter = parseTokenAccount(new PublicKey(post.owner), postData).amount;
  const expectedOut = outAfter - outBefore;
  if (expectedOut <= 0n) throw new Error("this swap would return nothing");
  const minimumOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const post_: TransactionInstruction[] = [];
  // Close the user's wSOL account when this transaction created it: the buy's wrapper, or the sell's own output (proceeds as SOL).
  const userWsolUsed = side === "buy" || output.equals(userWsol);
  if (userWsolUsed && !wsolExisted) post_.push(createCloseAccountInstruction(userWsol, user, user, [], KNOWN_ACCOUNTS.splToken));
  const tx = await finish(conn, new Transaction().add(...pre, swapIx(minimumOut), ...post_), user);
  const fee = dammBaseFeeScheduler(pool);
  const quote: SwapQuote = {
    side,
    venue: "damm-v2",
    amountIn,
    expectedOut,
    minimumOut,
    feeAmount: null,
    feeBps: fee.numberOfPeriod === 0 && pool.poolFees.dynamicFee.initialized === 0 ? Number((fee.cliffFeeNumerator * 10_000n) / 1_000_000_000n) : null,
    priceImpactBps: priceImpactBps(side, amountIn, expectedOut, pool.sqrtPrice),
    method: "simulation",
  };
  return { tx, quote };
}

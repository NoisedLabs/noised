/**
 * MOCK implementation of the PQ vault client, vault v4 (SPEC §3, §4.1 pq).
 * Keys, the withdraw message, LM-OTS signatures, instruction data and the v1
 * wire format all come from @noisedlabs/sdk; reads, simulation and sending run
 * against the simulated chain with the program's rules:
 *   - a vault lives at one address forever; `withdraw` verifies the current
 *     key's signature over the current sequence, only RESERVES
 *     `min(max_amount, balance - reserved)` in a payout PDA, increments the
 *     sequence and rotates the key in place. It moves no token, so nothing a
 *     recipient, a freeze authority or the Launch Guard does can block it;
 *   - `release` (anyone, to the recipient's canonical token account) and
 *     `release_to` (signed by the recipient, to any token account of the
 *     mint) deliver a payout; those transfers are what a frozen account or
 *     the Launch Guard can delay;
 *   - every landed `withdraw`, failed ones included, stays in the vault's
 *     history, which `findPendingWithdrawal` reads like the SDK does.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  associatedTokenAddress,
  ClusterMismatchError,
  CLUSTERS,
  compileV1Message,
  deriveVaultKey,
  FEE_PAYER_FUNDING_LAMPORTS,
  GENESIS_KEY_INDEX,
  IncompleteSearchError,
  keySequence,
  KNOWN_ACCOUNTS,
  lmots,
  MAX_COMPUTE_UNIT_LIMIT,
  nextKeyIndex,
  parseWithdrawMessage,
  payoutAddress,
  noisedHookAccounts,
  priorityFeeLamports,
  PROGRAM_IDS,
  RecipientConfirmationError,
  signV1Message,
  v1TransactionId,
  VAULT,
  VAULT_COMPUTE_UNITS,
  vaultAddress,
  VaultKeyInUseError,
  VaultLedgerError,
  withdrawalFromRecord,
  withdrawMessage,
  WSOL_MINT,
  type AssertClusterOptions,
  type CheckRecipientOptions,
  type Cluster,
  type ComputeBudgetOptions,
  type PayoutAccount,
  type PayoutListing,
  type PendingWithdrawal,
  type PendingWithdrawalSearch,
  type PendingWithdrawalSearchOptions,
  type PreparedWithdrawal,
  type PrepareWithdrawalOptions,
  type RecipientCheck,
  type RecipientConfirmation,
  type ScannedVault,
  type VaultAccount,
  type VaultInfo,
  type VaultKeyLedger,
  type VaultKeyRecord,
  type VaultMintCheck,
  type WithdrawalRequest,
  type WithdrawFallbackOptions,
  type WithdrawTx,
  type WithdrawTxArgs,
  type WithdrawTxWithFallback,
} from "@noisedlabs/sdk";
import { PublicKey, SystemProgram, type AccountMeta, type Connection, type Keypair, type Transaction, type TransactionInstruction } from "@solana/web3.js";

import { accountAt, ownerOfTokenAccount } from "./accounts";
import { bytesEqual, fromHex, toHex } from "./bytes";
import { chain } from "./chain";
import { guard, hookActive, liveLaunchByMint, mintFacts, RENT, runtime, vaultFail } from "./common";
import { budgetedTx, fakeBlockhash, idlIx, legacyTx, r, syncNativeIx, transferCheckedIx, w } from "./ix";
import { mockSignDeterministic } from "./lmotsSigner";
import { mockMint, payoutDelayWarnings, vaultMintPolicy } from "./mints";
import { register, simulate, type SimFailure } from "./sim";
import { addSol, addTokens, isFrozen, latency, nowSecs, solBalance, tokenAccountExists, tokenBalance, type MockPayout, type MockState, type MockVault } from "./store";

const SPL = KNOWN_ACCOUNTS.splToken;
const T22 = KNOWN_ACCOUNTS.token2022;
const U64_MAX = (1n << 64n) - 1n;
const isU64 = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= U64_MAX;

/** Rent of a token account of `tokenProgram`. */
const tokenAccountRent = (tokenProgram: PublicKey): bigint => (tokenProgram.equals(SPL) ? RENT.splAccount : RENT.t22Account);

/** A token account the simulated chain knows: one per (owner, mint), created by its first credit. */
const accountExists = tokenAccountExists;

function availableOf(s: MockState, v: MockVault): bigint {
  const balance = tokenBalance(s, v.address, v.mint);
  return balance > v.reserved ? balance - v.reserved : 0n;
}

function vaultAccountOf(v: MockVault): VaultAccount {
  return {
    publicKey: v.address,
    version: VAULT.VERSION,
    bump: v.bump,
    mint: v.mint,
    genesisKeyId: v.genesisKeyId,
    sequence: v.sequence,
    keyId: v.keyId,
    key: { id: v.key.id, q: v.key.q, k: v.key.k },
    reserved: v.reserved,
  };
}

function vaultInfoOf(s: MockState, v: MockVault): VaultInfo {
  const { tokenProgram } = mintFacts(s, v.mint);
  return {
    ...vaultAccountOf(v),
    tokenProgram,
    tokenAccount: associatedTokenAddress(v.address, v.mint, tokenProgram),
    balance: tokenBalance(s, v.address, v.mint),
    available: availableOf(s, v),
  };
}

function payoutAccountOf(p: MockPayout): PayoutAccount {
  return {
    publicKey: p.address,
    version: VAULT.PAYOUT_VERSION,
    bump: p.bump,
    vault: p.vault,
    sequence: p.sequence,
    destinationOwner: p.destinationOwner,
    amount: p.amount,
    rentPayer: p.rentPayer,
  };
}

const pda = (seeds: Uint8Array[]): { address: PublicKey; bump: number } => {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, PROGRAM_IDS.vault);
  return { address, bump };
};
const u64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const utf8 = (t: string): Uint8Array => new TextEncoder().encode(t);

/** Why a payout of `amount` from `v` to `destinationOwner`'s token account would fail now (null: it would land). */
function payoutFailure(s: MockState, now: number, v: MockVault, destinationOwner: PublicKey, amount: bigint, instruction: number): SimFailure | null {
  if (amount === 0n) return null;
  const { tokenProgram } = mintFacts(s, v.mint);
  if (isFrozen(s, v.address, v.mint)) return runtime("Program log: Error: Account is frozen (the vault's token account; its payouts wait until the freeze authority thaws it)");
  if (isFrozen(s, destinationOwner, v.mint)) return { kind: "runtime", message: "Program log: Error: Account is frozen (the destination token account)", instruction };
  const g = guard(
    liveLaunchByMint(s, v.mint),
    now,
    // The vault program's own instruction moves the tokens: the creator's rules are skipped (review 4, R1).
    { amount, isBuy: false, isSell: false, sourceOwner: v.address, destinationOwner, destinationBalanceAfter: tokenBalance(s, destinationOwner, v.mint) + amount, topProgram: PROGRAM_IDS.vault },
    [tokenProgram],
  );
  return g === null ? null : { ...g, instruction };
}

/** Move a payout's tokens to `destinationOwner`, release the reservation, close the payout (rent to its rent payer). */
function deliver(s: MockState, v: MockVault, p: MockPayout, destinationOwner: PublicKey): void {
  if (p.amount > 0n) {
    addTokens(s, v.address, v.mint, -p.amount);
    addTokens(s, destinationOwner, v.mint, p.amount);
  }
  v.reserved -= p.amount;
  addSol(s, p.rentPayer, RENT.payout);
  delete s.payouts[p.address.toBase58()];
}

// ------------------------------------------------------------------- reads ---

export async function checkVaultMint(_conn: Connection, mint: PublicKey): Promise<VaultMintCheck> {
  await latency("read");
  const s = chain();
  const m = mockMint(s, mint);
  if (!m) return { eligible: false, refusals: ["The mint account does not exist."], warnings: [], tokenProgram: null };
  const l = liveLaunchByMint(s, mint);
  const { refusals, warnings } = vaultMintPolicy(m, {
    guardEndTs: l && !l.curveComplete ? l.state.guardEndTs : null,
    p2pLocked: l?.state.p2pLocked ?? false,
    nowSecs: nowSecs(),
  });
  return { eligible: refusals.length === 0, refusals, warnings, tokenProgram: m.tokenProgram };
}

export async function fetchVault(_conn: Connection, vault: PublicKey): Promise<VaultInfo | null> {
  await latency("read");
  const s = chain();
  const v = s.vaults[vault.toBase58()];
  return v ? vaultInfoOf(s, v) : null;
}

export async function fetchPayout(_conn: Connection, vault: PublicKey, sequence: bigint): Promise<PayoutAccount | null> {
  await latency("read");
  const p = chain().payouts[payoutAddress(vault, sequence).toBase58()];
  return p && p.vault.equals(vault) ? payoutAccountOf(p) : null;
}

export async function listPayouts(_conn: Connection, vault: PublicKey): Promise<PayoutListing> {
  await latency("read");
  const s = chain();
  const v = s.vaults[vault.toBase58()];
  if (!v) throw new Error(`vault ${vault.toBase58()} does not exist`);
  const payouts = Object.values(s.payouts)
    .filter((p) => p.vault.equals(vault))
    .map(payoutAccountOf)
    .sort((a, b) => (a.sequence < b.sequence ? -1 : 1));
  const sum = payouts.reduce((t, p) => t + p.amount, 0n);
  return sum === v.reserved
    ? { payouts, complete: true, method: "getProgramAccounts", note: null }
    : { payouts, complete: false, method: "getProgramAccounts", note: `The listed payouts add up to ${sum} but the vault reserves ${v.reserved}.` };
}

/**
 * Vault accounts `0..=maxAccount` of a recovery phrase for `mint` (like the
 * SDK: one genesis key per account, keys from a private copy of `master`
 * taken before anything is read and wiped afterwards; an all-zero `master`
 * is refused).
 */
export async function scanVaults(_conn: Connection, master: Uint8Array, cluster: Cluster, mint: PublicKey, maxAccount: number): Promise<ScannedVault[]> {
  if (!Number.isInteger(maxAccount) || maxAccount < 0 || maxAccount > 1_000) throw new RangeError("maxAccount must be 0..=1000");
  if (!(master instanceof Uint8Array) || master.length !== 64) throw new RangeError("master must be the 64-byte BIP-39 seed");
  if (master.every((b) => b === 0)) throw new RangeError("refusing an all-zero master seed: it is not the seed of any phrase (was it wiped?), and every key derived from it is public");
  const seed = Uint8Array.from(master);
  try {
    await latency("read");
    return scanWith(seed, cluster, mint, maxAccount);
  } finally {
    seed.fill(0);
  }
}

function scanWith(seed: Uint8Array, cluster: Cluster, mint: PublicKey, maxAccount: number): ScannedVault[] {
  const s = chain();
  mintFacts(s, mint);
  const out: ScannedVault[] = [];
  for (let account = 0; account <= maxAccount; account++) {
    const genesis = deriveVaultKey(seed, cluster, mint, account, 0);
    genesis.skSeed.fill(0);
    const vault = vaultAddress(mint, genesis.keyId);
    const v = s.vaults[vault.toBase58()];
    const balance = tokenBalance(s, vault, mint);
    if (!v) {
      out.push({ account, vault, genesisKeyId: genesis.keyId, opened: false, sequence: 0n, keyId: null, keyMatches: null, balance, reserved: 0n, available: balance, pendingPayouts: [], payoutsComplete: true });
      continue;
    }
    let keyMatches = false;
    if (v.sequence <= 0xffff_ffffn) {
      const k = deriveVaultKey(seed, cluster, mint, account, keySequence(v.sequence));
      k.skSeed.fill(0);
      keyMatches = bytesEqual(k.keyId, v.keyId);
    }
    const pendingPayouts = Object.values(s.payouts)
      .filter((p) => p.vault.equals(vault))
      .map(payoutAccountOf)
      .sort((a, b) => (a.sequence < b.sequence ? -1 : 1));
    out.push({
      account,
      vault,
      genesisKeyId: genesis.keyId,
      opened: true,
      sequence: v.sequence,
      keyId: v.keyId,
      keyMatches,
      balance,
      reserved: v.reserved,
      available: availableOf(s, v),
      pendingPayouts,
      payoutsComplete: pendingPayouts.reduce((t, p) => t + p.amount, 0n) === v.reserved,
    });
  }
  return out;
}

/** Payout PDAs of the vault that `checkRecipient` recognises, whether they exist or not (the SDK's window): this many sequences before the vault's current one, and this many after it. */
const RECIPIENT_PAYOUTS_BEFORE = 1_024n;
const RECIPIENT_PAYOUTS_AFTER = 64n;

/**
 * The SDK's refusal for a recipient address it recognises as one that can
 * never use a payout (null if none): the all-zero address, the vault, the
 * vault's own token account, the connected wallet's own token account, or a
 * payout PDA of this vault. Token accounts and payouts are PDAs, so they are
 * only compared with off-curve addresses.
 */
function recognisedRecipient(destinationOwner: PublicKey, mint: PublicKey, vault: PublicKey, vaultSequence: bigint | null, wallet: PublicKey | null): string | null {
  const who = destinationOwner.toBase58();
  if (destinationOwner.equals(PublicKey.default)) return "The recipient is the all-zero address: nobody can ever sign for it.";
  if (destinationOwner.equals(vault)) {
    return "The recipient is this vault itself: the withdrawal would pay nothing and only rotate the key. Name the wallet that should receive the tokens.";
  }
  if (PublicKey.isOnCurve(destinationOwner.toBytes())) return null;
  const tokenPrograms = [SPL, T22];
  if (tokenPrograms.some((tp) => associatedTokenAddress(vault, mint, tp).equals(destinationOwner))) {
    return `${who} is this vault's own token account (its deposit address), not a wallet: the payout would go to a token account owned by that address, which nobody can use. Name the wallet that should receive the tokens.`;
  }
  if (wallet !== null && tokenPrograms.some((tp) => associatedTokenAddress(wallet, mint, tp).equals(destinationOwner))) {
    return `${who} is your connected wallet's own token account for this mint, not a wallet: the payout would go to a token account owned by that address, which nobody can use. Name your wallet address ${wallet.toBase58()} instead.`;
  }
  const around = vaultSequence ?? 0n;
  const from = around > RECIPIENT_PAYOUTS_BEFORE ? around - RECIPIENT_PAYOUTS_BEFORE : 0n;
  for (let s = from; s <= around + RECIPIENT_PAYOUTS_AFTER; s++) {
    if (payoutAddress(vault, s).equals(destinationOwner)) {
      return `${who} is the payout address of this vault's withdrawal at sequence ${s} (a Noised vault program address), not a wallet: nobody could ever move a payout made to it. Withdraw to a wallet.`;
    }
  }
  return null;
}

/**
 * The SDK's `checkRecipient` against the simulated chain, with the live
 * backend's Launch Guard warnings: the same refusals (the zero address, the
 * vault, its own token account, the connected wallet's own token account,
 * this vault's payout PDAs near its sequence, mints, token accounts, vaults
 * and payouts), the same recipient warnings (programs, accounts of other
 * programs, existing off-curve accounts, a frozen canonical token account),
 * token warnings (a frozen vault token account, mint powers that can delay a
 * payout, the Launch Guard) and the off-curve confirmation for an off-curve
 * address with no account.
 */
export async function checkRecipient(_conn: Connection, destinationOwner: PublicKey, mint: PublicKey, vault: PublicKey, opts: CheckRecipientOptions = {}): Promise<RecipientCheck> {
  if (!(destinationOwner instanceof PublicKey) || !(mint instanceof PublicKey) || !(vault instanceof PublicKey)) throw new TypeError("destinationOwner, mint and vault must be PublicKeys");
  if (opts.wallet !== undefined && opts.wallet !== null && !(opts.wallet instanceof PublicKey)) throw new TypeError("opts.wallet must be a PublicKey");
  await latency("read");
  return checkRecipientNow(chain(), destinationOwner, mint, vault, opts.wallet ?? null);
}

/** `checkRecipient` against the chain state `s` as it is now. */
function checkRecipientNow(s: MockState, destinationOwner: PublicKey, mint: PublicKey, vault: PublicKey, wallet: PublicKey | null): RecipientCheck {
  const refusals: string[] = [];
  const recipientWarnings: string[] = [];
  const mintWarnings: string[] = [];
  let offCurveConfirmation: string | null = null;
  const who = destinationOwner.toBase58();

  const recognised = recognisedRecipient(destinationOwner, mint, vault, s.vaults[vault.toBase58()]?.sequence ?? null, wallet);
  const owner = accountAt(s, destinationOwner);
  if (recognised !== null) refusals.push(recognised);
  else if (owner !== null && (owner.hasData || owner.executable)) {
    if (owner.owner.equals(SPL) || owner.owner.equals(T22)) {
      refusals.push(
        `${who} is a ${mockMint(s, destinationOwner) ? "mint" : "token account"} (owned by ${owner.owner.toBase58()}), not a wallet: the payout would go to a token account owned by that address, which nobody can use. Name the wallet that owns it instead.`,
      );
    } else if (owner.owner.equals(PROGRAM_IDS.vault)) {
      refusals.push(`${who} is an account of the Noised vault program (a vault or a payout), not a wallet: it cannot sign release_to and nobody could move a payout made to it. Withdraw to a wallet.`);
    } else if (owner.executable) {
      recipientWarnings.push(`${who} is a program, not a wallet: tokens paid to its token account can be moved only by whoever holds that address's private key, if anyone.`);
    } else if (!owner.owner.equals(KNOWN_ACCOUNTS.system)) {
      recipientWarnings.push(`${who} is an account of program ${owner.owner.toBase58()}, not a plain wallet: make sure that program can use tokens paid to its canonical token account.`);
    }
  }
  if (refusals.length === 0 && !PublicKey.isOnCurve(destinationOwner.toBytes())) {
    if (owner === null) {
      offCurveConfirmation = `${who} is off the Ed25519 curve (no private key exists for it) and has no account on chain. It can be a program's wallet that was never used, such as a multisig vault: then release pays its canonical token account and only that program can move the tokens. But if it is the address of a token account (an associated token account that was closed or not created yet), of a vault or a payout, or any address no program controls, the payout is lost forever. Confirm only if you know which program controls ${who} and that it can use tokens of this mint.`;
    } else {
      recipientWarnings.push(
        `${who} is a program address (off the Ed25519 curve) with no private key: release can pay its canonical token account, but release_to (needed if that account cannot receive) can only be signed by its program.`,
      );
    }
  }

  const m = mockMint(s, mint);
  let canonicalAta: PublicKey | null = null;
  if (!m) refusals.push(`The mint ${mint.toBase58()} does not exist.`);
  else {
    canonicalAta = associatedTokenAddress(destinationOwner, mint, m.tokenProgram);
    if (isFrozen(s, destinationOwner, mint)) {
      recipientWarnings.push(
        `The recipient's token account ${canonicalAta.toBase58()} (where release pays): it is frozen. release will fail until that changes; the recipient can sign release_to to another token account of this mint instead.`,
      );
    }
    if (isFrozen(s, vault, mint)) mintWarnings.push("The vault's token account is frozen right now: the withdrawal still executes, but its payout waits until the freeze authority thaws the account.");
    mintWarnings.push(...payoutDelayWarnings(m));
    const l = liveLaunchByMint(s, mint);
    const now = nowSecs();
    if (refusals.length === 0 && l && hookActive(l) && BigInt(now) < l.state.guardEndTs) {
      const end = new Date(Number(l.state.guardEndTs) * 1000).toISOString().replace(".000Z", "Z");
      if (l.state.p2pLocked) {
        mintWarnings.push(
          `The Noised Launch Guard pauses wallet-to-wallet transfers of this token until ${end}: the withdrawal executes now and reserves the payout, but delivering it (release or release_to) is refused until then.`,
        );
      }
      if (l.state.maxWalletBps > 0) {
        mintWarnings.push(
          `Until ${end} the Launch Guard's max-wallet cap (${l.state.maxWalletBps / 100}% of the supply) applies to the recipient: a payout that would put the recipient's account above it is refused until the guard ends.`,
        );
      }
    }
  }
  return { ok: refusals.length === 0, refusals, recipientWarnings, mintWarnings, offCurveConfirmation, canonicalAta, destinationOwner, mint, vault, wallet };
}

/**
 * Withdrawals the vault's CURRENT key already signed, like the SDK's search:
 * every landed `withdraw` of the vault (failed ones included) whose
 * signature verifies with the current key over the message rebuilt for the
 * current sequence, newest first. A next key is authenticated separately
 * (it must hash to the signed next key id; the authentic one is taken from
 * any transaction that carries it): `executable` when it is known, has
 * `q = sequence + 1` and is not the current key; `pending` is the newest
 * executable one; `all` lists every message the key signed. The simulated
 * chain keeps its whole history, so the search always completes in one call
 * and never returns a continuation; its options are validated like the SDK's.
 */
export async function findPendingWithdrawal(_conn: Connection, vault: PublicKey, opts: PendingWithdrawalSearchOptions = {}): Promise<PendingWithdrawalSearch> {
  const maxTransactions = opts.maxTransactions ?? 1_000;
  const maxPages = opts.maxSignaturePages ?? 200;
  if (!Number.isInteger(maxTransactions) || maxTransactions < 1) throw new RangeError("maxTransactions must be a positive integer");
  if (!Number.isInteger(maxPages) || maxPages < 2) throw new RangeError("maxSignaturePages must be an integer of at least 2 (a continued call first reads a page of what landed since)");
  if (opts.continueFrom !== undefined && opts.continueFrom !== null) throw new RangeError("continueFrom is not a continuation returned by findPendingWithdrawal in this process");
  await latency("read");
  const s = chain();
  const v = s.vaults[vault.toBase58()];
  if (!v) throw new Error(`vault ${vault.toBase58()} does not exist`);
  const history = [...(s.vaultHistory[vault.toBase58()] ?? [])].reverse();
  const found = new Map<string, PendingWithdrawal>();
  const wantQ = nextKeyIndex(v.sequence);
  for (const h of history) {
    const message = withdrawMessage(vault, v.mint, v.sequence, h.destinationOwner, h.maxAmount, h.nextKeyId);
    if (h.signature.length !== VAULT.SIGNATURE_LEN || !lmots.verify(v.key, message, h.signature)) continue;
    let authentic: lmots.LmotsPublicKey | null = null;
    try {
      if (bytesEqual(lmots.keyId(h.nextKey), h.nextKeyId)) authentic = { id: h.nextKey.id, q: h.nextKey.q, k: h.nextKey.k };
    } catch {
      authentic = null;
    }
    const id = toHex(message);
    const seen = found.get(id);
    if (seen !== undefined) {
      // The same signature again: keep the newest occurrence, completed with an authentic next key if this one carries it.
      if (seen.nextKey === null && authentic !== null) found.set(id, { ...seen, nextKey: authentic, executable: authentic.q === wantQ && !bytesEqual(h.nextKeyId, v.keyId) });
      continue;
    }
    found.set(id, {
      txSignature: h.txSignature,
      failed: h.failed,
      executable: authentic !== null && authentic.q === wantQ && !bytesEqual(h.nextKeyId, v.keyId),
      slot: h.slot,
      vault,
      mint: v.mint,
      sequence: v.sequence,
      destinationOwner: h.destinationOwner,
      maxAmount: h.maxAmount,
      nextKeyId: h.nextKeyId,
      nextKey: authentic,
      signature: h.signature,
      message,
    });
  }
  const all = [...found.values()];
  return { vault: vaultAccountOf(v), pending: all.find((p) => p.executable) ?? null, all, complete: true, incompleteReason: null, continuation: null, examined: history.length, note: null };
}

// ---------------------------------------------------------------- builders ---

export async function buildOpenVaultTx(_conn: Connection, payer: PublicKey, mint: PublicKey, pk: lmots.LmotsPublicKey): Promise<Transaction> {
  await latency("build");
  if (pk.q !== 0) throw new Error(`a vault opens with its genesis key (sequence 0); this key has q = ${pk.q}`);
  const s = chain();
  const m = mockMint(s, mint);
  const policy = m ? vaultMintPolicy(m, { guardEndTs: null, p2pLocked: false, nowSecs: nowSecs() }) : { refusals: ["The mint account does not exist."], warnings: [] };
  if (!m || policy.refusals.length > 0) throw new Error(`open_vault would refuse this mint: ${policy.refusals.join(" ")}`);
  const tokenProgram = m.tokenProgram;
  const keyId = lmots.keyId(pk);
  const vault = vaultAddress(mint, keyId);
  if (s.vaults[vault.toBase58()]) throw new Error(`vault ${vault.toBase58()} is already open; a genesis key opens one vault only`);
  const vaultTokenAccount = associatedTokenAddress(vault, mint, tokenProgram);
  const ix = idlIx(
    "vault",
    "open_vault",
    [w(payer, true), r(mint), w(vault), w(vaultTokenAccount), r(tokenProgram), r(KNOWN_ACCOUNTS.associatedToken), r(KNOWN_ACCOUNTS.system)],
    { keyIdArg: keyId, key: { id: pk.id, q: pk.q, k: pk.k } },
  );
  const tx = legacyTx(payer, [ix]);
  const ataExists = accountExists(s, vault, mint);
  register(tx, {
    label: "OpenVault",
    program: PROGRAM_IDS.vault,
    computeUnits: 26_000,
    payer,
    rent: RENT.vault + (ataExists ? 0n : tokenAccountRent(tokenProgram)),
    solOut: 0n,
    check: (st) => {
      if (st.vaults[vault.toBase58()]) return runtime(`Allocate: account Address { address: ${vault.toBase58()}, base: None } already in use (a genesis key opens one vault, once)`);
      const cur = mockMint(st, mint);
      if (!cur) return runtime("AnchorError caused by account: mint. Error Code: AccountNotInitialized.");
      return vaultMintPolicy(cur, { guardEndTs: null, p2pLocked: false, nowSecs: nowSecs() }).refusals.length > 0 ? vaultFail("UnsupportedMint") : null;
    },
    apply: (st) => {
      const { bump } = pda([utf8("vault"), mint.toBytes(), keyId]);
      st.vaults[vault.toBase58()] = { address: vault, bump, mint, genesisKeyId: keyId, sequence: 0n, keyId, key: { id: pk.id, q: pk.q, k: pk.k }, reserved: 0n };
      // `init_if_needed`: the deposit address exists from now on.
      addTokens(st, vault, mint, 0n);
    },
    logs: () => [`VaultOpened { vault: ${vault.toBase58()}, mint: ${mint.toBase58()}, key_id: ${toHex(keyId).slice(0, 16)}… }`],
  });
  return tx;
}

/**
 * Deposit into the vault's token account (the deposit address). wSOL: a SOL
 * transfer into that account and SyncNative; other mints: TransferChecked
 * from the owner's account, with the Launch Guard's accounts when active.
 */
export async function buildDepositTx(_conn: Connection, owner: PublicKey, mint: PublicKey, vault: PublicKey, amount: bigint): Promise<Transaction> {
  await latency("build");
  if (amount <= 0n || amount > U64_MAX) throw new RangeError("amount must be a positive u64");
  const s = chain();
  const v = s.vaults[vault.toBase58()];
  if (!v) throw new Error(`vault ${vault.toBase58()} does not exist`);
  if (!v.mint.equals(mint)) throw new Error("vault holds a different mint");
  const { decimals, tokenProgram } = mintFacts(s, mint);
  const destination = associatedTokenAddress(vault, mint, tokenProgram);
  if (!accountExists(s, vault, mint)) throw new Error(`the vault's token account ${destination.toBase58()} does not exist`);
  const wsol = mint.equals(WSOL_MINT);
  const l = liveLaunchByMint(s, mint);
  const ixs: TransactionInstruction[] = wsol
    ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: destination, lamports: amount }), syncNativeIx(destination)]
    : [
        transferCheckedIx({
          source: associatedTokenAddress(owner, mint, tokenProgram),
          mint,
          destination,
          owner,
          amount,
          decimals,
          tokenProgram,
          hookActive: hookActive(l),
        }),
      ];
  const tx = legacyTx(owner, ixs);
  register(tx, {
    label: wsol ? "SyncNative" : "TransferChecked",
    program: wsol ? SPL : tokenProgram,
    computeUnits: wsol ? 3_000 : hookActive(l) ? 23_400 : 6_200,
    payer: owner,
    rent: 0n,
    solOut: wsol ? amount : 0n,
    check: (st, now) => {
      if (!st.vaults[vault.toBase58()]) return runtime("Deposit refused: the vault does not exist.");
      if (isFrozen(st, vault, mint)) return runtime("Program log: Error: Account is frozen");
      if (wsol) return null;
      if (tokenBalance(st, owner, mint) < amount) return runtime("Program log: Error: insufficient funds");
      return guard(
        liveLaunchByMint(st, mint),
        now,
        { amount, isBuy: false, isSell: false, sourceOwner: owner, destinationOwner: vault, destinationBalanceAfter: tokenBalance(st, vault, mint) + amount },
        [],
      );
    },
    apply: (st) => {
      if (wsol) addSol(st, owner, -amount);
      else addTokens(st, owner, mint, -amount);
      addTokens(st, vault, mint, amount);
    },
  });
  return tx;
}

function releaseAccounts(
  payer: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  vaultTokenAccount: PublicKey,
  payout: PublicKey,
  rentPayer: PublicKey,
  destinationOwner: PublicKey,
  destination: PublicKey,
  tokenProgram: PublicKey,
  hook: AccountMeta[],
): AccountMeta[] {
  return [
    w(payer, true),
    r(mint),
    w(vault),
    w(vaultTokenAccount),
    w(payout),
    w(rentPayer),
    r(destinationOwner),
    w(destination),
    r(KNOWN_ACCOUNTS.memo),
    r(tokenProgram),
    r(KNOWN_ACCOUNTS.associatedToken),
    r(KNOWN_ACCOUNTS.system),
    ...hook,
  ];
}

/** The default compute-unit limit of `release` / `release_to` for a mint (the SDK's `VAULT_COMPUTE_UNITS`). */
function releaseComputeUnits(s: MockState, mint: PublicKey): number {
  const m = mockMint(s, mint);
  if (m === null || m.tokenProgram.equals(SPL)) return VAULT_COMPUTE_UNITS.releaseSplToken;
  const hook = m.extensions.find((e) => e.type === "TransferHook");
  const program = hook?.type === "TransferHook" ? hook.programId : null;
  return program === null || program.equals(PROGRAM_IDS.hook) ? VAULT_COMPUTE_UNITS.releaseToken2022 : VAULT_COMPUTE_UNITS.releaseOtherHook;
}

/** Same pre-checks as the SDK's builder (key-index binding included), then the real v1 wire bytes signed by the throwaway fee payer, with the SDK's compute budget. */
export async function buildWithdrawTx(_conn: Connection, payer: Keypair, args: WithdrawTxArgs, opts: ComputeBudgetOptions = {}): Promise<WithdrawTx> {
  await latency("build");
  return buildWithdrawNow(chain(), payer, args, opts);
}

function buildWithdrawNow(s: MockState, payer: Keypair, args: WithdrawTxArgs, opts: ComputeBudgetOptions): WithdrawTx {
  const { mint, vault, sequence, destinationOwner, maxAmount, signature, nextKey, nextKeyId } = args;
  if (!(signature instanceof Uint8Array) || signature.length !== VAULT.SIGNATURE_LEN) throw new RangeError(`signature must be ${VAULT.SIGNATURE_LEN} bytes`);
  if (!isU64(sequence)) throw new RangeError("sequence must be a u64");
  if (!isU64(maxAmount)) throw new RangeError("maxAmount must be a u64");
  if (!(nextKeyId instanceof Uint8Array) || nextKeyId.length !== 32 || nextKeyId.every((b) => b === 0)) throw new RangeError("nextKeyId must be a non-zero 32-byte key id");
  if (!bytesEqual(lmots.keyId(nextKey), nextKeyId)) throw new Error("the next key does not hash to nextKeyId (KeyIdMismatch)");
  const wantQ = nextKeyIndex(sequence);
  if (nextKey.q !== wantQ) {
    throw new Error(
      wantQ === null
        ? `no withdrawal can execute at sequence ${sequence}: no next key index follows it (InvalidKeyIndex)`
        : `the next key has index q = ${nextKey.q}, but the withdrawal at sequence ${sequence} must name the key of index ${wantQ} (InvalidKeyIndex): this signature can never execute`,
    );
  }
  if (opts.computeUnitLimit !== undefined && (!Number.isInteger(opts.computeUnitLimit) || opts.computeUnitLimit < 1 || opts.computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT)) {
    throw new RangeError(`computeUnitLimit must be an integer between 1 and ${MAX_COMPUTE_UNIT_LIMIT}`);
  }
  const v = s.vaults[vault.toBase58()];
  if (!v) throw new Error(`vault ${vault.toBase58()} does not exist`);
  if (!v.mint.equals(mint)) throw new Error("vault holds a different mint");
  if (v.sequence > sequence) {
    throw new Error(
      `the withdrawal at sequence ${sequence} has already executed (the vault is at sequence ${v.sequence}): release its payout if it is still pending; never sign again for an old sequence`,
    );
  }
  if (v.sequence < sequence) throw new Error(`the message is for sequence ${sequence} but the vault is at sequence ${v.sequence}: it cannot execute`);
  if (bytesEqual(nextKeyId, v.keyId)) throw new Error("the next key must differ from the vault's current key (InvalidNextKey)");
  const msg = withdrawMessage(vault, mint, sequence, destinationOwner, maxAmount, nextKeyId);
  if (!lmots.verify(v.key, msg, signature)) {
    throw new Error("the LM-OTS signature does not verify with the vault's current key over this withdrawal (wrong key, sequence, recipient, amount or next key)");
  }

  const { tokenProgram } = mintFacts(s, mint);
  const vaultTokenAccount = associatedTokenAddress(vault, mint, tokenProgram);
  const payout = payoutAddress(vault, sequence);
  const toVault = destinationOwner.equals(vault);
  const expectedAmount = toVault ? 0n : maxAmount < availableOf(s, v) ? maxAmount : availableOf(s, v);
  const includesRelease = args.includeRelease === true;
  const destination = associatedTokenAddress(destinationOwner, mint, tokenProgram);
  const l = liveLaunchByMint(s, mint);
  const ixs: TransactionInstruction[] = [
    idlIx("vault", "withdraw", [w(payer.publicKey, true), r(mint), w(vault), r(vaultTokenAccount), w(payout), r(tokenProgram), r(KNOWN_ACCOUNTS.system)], {
      args: { signature, destinationOwner, maxAmount, nextKeyId, nextKey: { id: nextKey.id, q: nextKey.q, k: nextKey.k } },
    }),
  ];
  if (includesRelease) {
    const hook = hookActive(l) ? noisedHookAccounts(mint, "resolver") : [];
    ixs.push(idlIx("vault", "release", releaseAccounts(payer.publicKey, mint, vault, vaultTokenAccount, payout, payer.publicKey, destinationOwner, destination, tokenProgram, hook)));
  }
  const defaultLimit = includesRelease ? Math.min(MAX_COMPUTE_UNIT_LIMIT, VAULT_COMPUTE_UNITS.withdraw + releaseComputeUnits(s, mint)) : VAULT_COMPUTE_UNITS.withdraw;
  const computeUnitLimit = opts.computeUnitLimit ?? defaultLimit;
  const price = opts.computeUnitPrice ?? null;
  const fee = price === null || price === 0n ? 0n : priorityFeeLamports(price, computeUnitLimit);
  const blockhash = fakeBlockhash();
  const message = compileV1Message(payer.publicKey, ixs, blockhash, {
    computeUnitLimit,
    loadedAccountsDataSizeLimit: VAULT.WITHDRAW_LOADED_ACCOUNTS_BYTES,
    ...(price === null ? {} : { priorityFeeLamports: fee }),
  });
  const tx = signV1Message(message, [payer]);
  const ataRent = includesRelease && expectedAmount > 0n && !accountExists(s, destinationOwner, mint) ? tokenAccountRent(tokenProgram) : 0n;
  /** What this withdrawal reserves against the chain state `st`. */
  const amountIn = (st: MockState, cur: MockVault): bigint => {
    if (toVault) return 0n;
    const avail = availableOf(st, cur);
    return maxAmount < avail ? maxAmount : avail;
  };
  register(tx, {
    label: includesRelease ? "Withdraw + Release" : "Withdraw",
    program: PROGRAM_IDS.vault,
    computeUnits: 92_000 + (includesRelease ? 46_000 + (hookActive(l) ? 22_000 : 0) : 0),
    payer: payer.publicKey,
    rent: RENT.payout + ataRent,
    solOut: 0n,
    check: (st, now) => {
      const cur = st.vaults[vault.toBase58()];
      if (!cur) return runtime("AnchorError caused by account: vault. Error Code: AccountNotInitialized. No vault is open at this address.");
      // Account constraints first (the payout PDA is derived from the vault's current sequence), then the handler's checks.
      if (cur.sequence !== sequence) return runtime("AnchorError caused by account: payout. Error Code: ConstraintSeeds. A seeds constraint was violated.");
      if (!bytesEqual(lmots.keyId(nextKey), nextKeyId)) return vaultFail("KeyIdMismatch");
      if (nextKey.q !== nextKeyIndex(cur.sequence)) return vaultFail("InvalidKeyIndex");
      if (bytesEqual(nextKeyId, cur.keyId)) return vaultFail("InvalidNextKey");
      if (!lmots.verify(cur.key, withdrawMessage(vault, mint, cur.sequence, destinationOwner, maxAmount, nextKeyId), signature)) return vaultFail("InvalidSignature");
      return includesRelease ? payoutFailure(st, now, cur, destinationOwner, amountIn(st, cur), 1) : null;
    },
    apply: (st) => {
      const cur = st.vaults[vault.toBase58()];
      if (!cur) return;
      const amount = amountIn(st, cur);
      const { bump } = pda([utf8("payout"), vault.toBytes(), u64le(sequence)]);
      const p: MockPayout = { address: payout, bump, vault, sequence, destinationOwner, amount, rentPayer: payer.publicKey };
      cur.reserved += amount;
      cur.sequence = sequence + 1n;
      cur.keyId = nextKeyId;
      cur.key = { id: nextKey.id, q: nextKey.q, k: nextKey.k };
      st.payouts[payout.toBase58()] = p;
      if (includesRelease) deliver(st, cur, p, destinationOwner);
    },
    landed: (st, o) => {
      const list = (st.vaultHistory[vault.toBase58()] ??= []);
      list.push({ txSignature: o.txSignature, failed: o.failed, slot: o.slot, destinationOwner, maxAmount, nextKeyId, nextKey: { id: nextKey.id, q: nextKey.q, k: nextKey.k }, signature });
    },
    logs: (st) => {
      const cur = st.vaults[vault.toBase58()];
      const amount = cur ? amountIn(st, cur) : 0n;
      const lines = [
        "LM-OTS signature verified (LMOTS_SHA256_N32_W4)",
        `VaultWithdrawn { vault: ${vault.toBase58()}, sequence: ${sequence}, destination_owner: ${destinationOwner.toBase58()}, amount: ${amount}, payout: ${payout.toBase58()} }`,
      ];
      if (includesRelease) lines.push(`PayoutReleased { payout: ${payout.toBase58()}, destination: ${destination.toBase58()}, amount: ${amount} }`);
      return lines;
    },
  });
  return { tx, signature: v1TransactionId(tx), blockhash, lastValidBlockHeight: 0, vault, payout, includesRelease, expectedAmount, computeUnitLimit, priorityFeeLamports: fee };
}

/**
 * Like the SDK: withdraw + release when the pair passes simulation now,
 * otherwise the withdrawal alone with the same signature. Simulating reveals
 * the signature, so it refuses (before any simulation) a signature that
 * `opts.ledger` does not hold for this exact withdrawal. It falls back on
 * any failure of the release leg, never on a failure of the withdraw leg.
 */
export async function buildWithdrawTxWithFallback(_conn: Connection, payer: Keypair, args: Omit<WithdrawTxArgs, "includeRelease">, opts: WithdrawFallbackOptions): Promise<WithdrawTxWithFallback> {
  const ledger = requireLedger(opts, "buildWithdrawTxWithFallback");
  await latency("build");
  const s = chain();
  const alone = buildWithdrawNow(s, payer, { ...args, includeRelease: false }, opts);
  const v = s.vaults[args.vault.toBase58()];
  const rec = v === undefined ? null : await ledger.get(v.keyId);
  const message = withdrawMessage(args.vault, args.mint, args.sequence, args.destinationOwner, args.maxAmount, args.nextKeyId);
  if (rec === null || rec.signature === null || rec.messageHash !== toHex(sha256(message)) || rec.signature !== toHex(args.signature)) {
    throw new VaultLedgerError(
      "refusing to simulate: the vault-key ledger does not hold this signature for this withdrawal, and a simulation reveals it to the RPC. Sign through prepareWithdrawal or signWithdrawal with this ledger (a withdrawal found on chain is recorded by prepareWithdrawal).",
    );
  }
  let releaseError: string;
  let combined: WithdrawTx | null = null;
  try {
    combined = buildWithdrawNow(chain(), payer, { ...args, includeRelease: true }, opts);
  } catch (e) {
    releaseError = `withdraw + release could not be built (${e instanceof Error ? e.message : String(e)})`;
  }
  if (combined !== null) {
    const simulation = await simulate(combined.tx);
    if (simulation.ok || simulation.failedInstruction === 0) return { ...combined, releaseError: null, simulation };
    releaseError =
      simulation.failedInstruction === 1 ? `the release fails: ${simulation.error ?? "unknown error"}` : `withdraw + release fails as a whole: ${simulation.error ?? "unknown error"}`;
  }
  return { ...alone, releaseError: releaseError!, simulation: await simulate(alone.tx) };
}

function payoutContext(s: MockState, vault: PublicKey, mint: PublicKey, sequence: bigint): { v: MockVault; p: MockPayout; tokenProgram: PublicKey } {
  const v = s.vaults[vault.toBase58()];
  if (!v) throw new Error(`vault ${vault.toBase58()} does not exist`);
  if (!v.mint.equals(mint)) throw new Error("vault holds a different mint");
  const p = s.payouts[payoutAddress(vault, sequence).toBase58()];
  if (!p) {
    throw new Error(
      sequence < v.sequence
        ? `the payout of sequence ${sequence} has already been released`
        : `there is no payout at sequence ${sequence} yet (the vault is at sequence ${v.sequence}): broadcast the withdrawal first`,
    );
  }
  return { v, p, tokenProgram: mintFacts(s, mint).tokenProgram };
}

/** `release` (permissionless): pay the payout to its recipient's canonical token account, creating it if missing. */
export async function buildReleaseTx(_conn: Connection, payer: PublicKey, args: { vault: PublicKey; mint: PublicKey; sequence: bigint }, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  await latency("build");
  const { vault, mint, sequence } = args;
  const s = chain();
  const { p, tokenProgram } = payoutContext(s, vault, mint, sequence);
  const destination = associatedTokenAddress(p.destinationOwner, mint, tokenProgram);
  if (p.amount > 0n && isFrozen(s, p.destinationOwner, mint)) {
    throw new Error(`the recipient's token account ${destination.toBase58()} cannot receive: it is frozen. The recipient can sign release_to (buildReleaseToTx) to another token account of this mint.`);
  }
  const l = liveLaunchByMint(s, mint);
  const hook = hookActive(l) ? noisedHookAccounts(mint, "resolver") : [];
  const ix = idlIx(
    "vault",
    "release",
    releaseAccounts(payer, mint, vault, associatedTokenAddress(vault, mint, tokenProgram), p.address, p.rentPayer, p.destinationOwner, destination, tokenProgram, hook),
  );
  const tx = budgetedTx(payer, [ix], releaseComputeUnits(s, mint), opts);
  return registerDelivery(tx, s, { payer, vault, mint, sequence, label: "Release", destinationOwner: p.destinationOwner, createsAccount: p.amount > 0n && !accountExists(s, p.destinationOwner, mint) });
}

/**
 * `release_to`: the payout's recipient pays itself into any token account of the mint. The live backend also refuses,
 * while the Launch Guard is on, an account whose owner can be reassigned (audit round 3, F2: HookError 6010); every
 * token account of the simulated chain is a canonical associated token account, which always has an immutable owner,
 * so that refusal cannot arise here.
 */
export async function buildReleaseToTx(
  _conn: Connection,
  recipient: PublicKey,
  args: { vault: PublicKey; mint: PublicKey; sequence: bigint; destination: PublicKey },
  opts: ComputeBudgetOptions = {},
): Promise<Transaction> {
  await latency("build");
  const { vault, mint, sequence, destination } = args;
  const s = chain();
  const { p, tokenProgram } = payoutContext(s, vault, mint, sequence);
  if (!p.destinationOwner.equals(recipient)) throw new Error(`only the payout's recipient ${p.destinationOwner.toBase58()} can sign release_to`);
  const target = ownerOfTokenAccount(s, destination, mint);
  if (target === null) throw new Error(`destination ${destination.toBase58()} does not exist: create a token account of this mint first`);
  if (p.amount > 0n && isFrozen(s, target.owner, mint)) throw new Error(`destination ${destination.toBase58()} cannot receive this payout: it is frozen`);
  const l = liveLaunchByMint(s, mint);
  const hook = hookActive(l) ? noisedHookAccounts(mint, "resolver") : [];
  const ix = idlIx("vault", "release_to", [
    r(recipient, true),
    r(mint),
    w(vault),
    w(associatedTokenAddress(vault, mint, tokenProgram)),
    w(p.address),
    w(p.rentPayer),
    w(destination),
    r(KNOWN_ACCOUNTS.memo),
    r(tokenProgram),
    ...hook,
  ]);
  const tx = budgetedTx(recipient, [ix], releaseComputeUnits(s, mint), opts);
  return registerDelivery(tx, s, { payer: recipient, vault, mint, sequence, label: "ReleaseTo", destinationOwner: target.owner, createsAccount: false });
}

function registerDelivery(
  tx: Transaction,
  s: MockState,
  d: { payer: PublicKey; vault: PublicKey; mint: PublicKey; sequence: bigint; label: string; destinationOwner: PublicKey; createsAccount: boolean },
): Transaction {
  const { tokenProgram } = mintFacts(s, d.mint);
  const payout = payoutAddress(d.vault, d.sequence);
  const l = liveLaunchByMint(s, d.mint);
  register(tx, {
    label: d.label,
    program: PROGRAM_IDS.vault,
    computeUnits: 41_000 + (hookActive(l) ? 22_000 : 0),
    payer: d.payer,
    rent: d.createsAccount ? tokenAccountRent(tokenProgram) : 0n,
    solOut: 0n,
    check: (st, now) => {
      const v = st.vaults[d.vault.toBase58()];
      const p = st.payouts[payout.toBase58()];
      if (!v || !p) return runtime("AnchorError caused by account: payout. Error Code: AccountNotInitialized. The payout was already delivered.");
      return payoutFailure(st, now, v, d.destinationOwner, p.amount, 1);
    },
    apply: (st) => {
      const v = st.vaults[d.vault.toBase58()];
      const p = st.payouts[payout.toBase58()];
      if (v && p) deliver(st, v, p, d.destinationOwner);
    },
    logs: (st) => {
      const p = st.payouts[payout.toBase58()];
      return [`PayoutReleased { vault: ${d.vault.toBase58()}, payout: ${payout.toBase58()}, sequence: ${d.sequence}, destination_owner: ${p?.destinationOwner.toBase58() ?? "?"}, amount: ${p?.amount ?? 0n} }`];
    },
  });
  return tx;
}

/** Fund a throwaway fee payer from the connected wallet (a plain SOL transfer). */
export async function buildFundFeePayerTx(_conn: Connection, from: PublicKey, feePayer: PublicKey, lamports: bigint = FEE_PAYER_FUNDING_LAMPORTS): Promise<Transaction> {
  await latency("build");
  if (lamports <= 0n) throw new RangeError("lamports must be a positive u64");
  const tx = legacyTx(from, [SystemProgram.transfer({ fromPubkey: from, toPubkey: feePayer, lamports })]);
  register(tx, {
    label: "Transfer",
    program: KNOWN_ACCOUNTS.system,
    computeUnits: 150,
    payer: from,
    rent: 0n,
    solOut: lamports,
    check: () => null,
    apply: (st) => {
      addSol(st, from, -lamports);
      addSol(st, feePayer, lamports);
    },
  });
  return tx;
}

/** Return everything left on a throwaway fee payer (minus the fee) to `to`, signed by the fee payer like the SDK's. */
export async function buildRefundFeePayerTx(_conn: Connection, feePayer: Keypair, to: PublicKey): Promise<Transaction> {
  await latency("build");
  const s = chain();
  const balance = solBalance(s, feePayer.publicKey);
  const lamports = balance - 5_000n;
  if (lamports <= 0n) throw new Error("nothing to refund");
  const tx = legacyTx(feePayer.publicKey, [SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: to, lamports })]);
  tx.sign(feePayer);
  register(tx, {
    label: "Transfer",
    program: KNOWN_ACCOUNTS.system,
    computeUnits: 150,
    payer: feePayer.publicKey,
    rent: 0n,
    solOut: lamports,
    check: () => null,
    apply: (st) => {
      addSol(st, feePayer.publicKey, -lamports);
      addSol(st, to, lamports);
    },
  });
  return tx;
}

// ------------------------------------------------------- signing (prepareWithdrawal) ---
// The SDK's `prepareWithdrawal`, step for step, against the simulated chain:
// the same private copies, refusal order, error classes and messages, the
// same vault-key ledger rule (reserve before signing, record before
// returning) and one-message-per-key guard for this process. Only the last
// step differs: the SDK's signer is internal, so the deterministic LM-OTS
// signature comes from ./lmotsSigner (byte-identical; checked in tests).

/** Key id (hex) -> the message (hex) this process saw that key sign (the SDK's session guard). */
const signedThisSession = new Map<string, string>();

function sawSignature(pk: lmots.LmotsPublicKey, msg: Uint8Array): void {
  const id = toHex(lmots.keyId(pk));
  if (!signedThisSession.has(id)) signedThisSession.set(id, toHex(msg));
}

/** Only for tests: forget what this process saw signing (a fresh page load). */
export function resetSigningSessionForTests(): void {
  signedThisSession.clear();
}

function requireLedger(opts: { readonly ledger?: VaultKeyLedger | undefined } | undefined, what: string): VaultKeyLedger {
  const ledger = opts?.ledger;
  if (ledger === undefined || ledger === null || typeof ledger !== "object" || typeof ledger.reserve !== "function" || typeof ledger.get !== "function") {
    throw new TypeError(
      `${what} needs opts.ledger, a durable vault-key ledger (createVaultKeyLedger on a persistent store with an atomic add, shared by every tab and device holding the phrase): a one-time key must be recorded before it signs`,
    );
  }
  return ledger;
}

const isKey = (v: unknown): v is PublicKey => v instanceof PublicKey;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const copyKey = (v: unknown): PublicKey | undefined => (isKey(v) ? new PublicKey(v.toBytes()) : undefined);

/** `opts.confirm` as a private, frozen copy (the SDK's `requireConfirmation`). */
function requireConfirmation(opts: { readonly confirm?: RecipientConfirmation | undefined } | undefined, what: string): RecipientConfirmation {
  const c = opts?.confirm;
  if (c === undefined || c === null || typeof c !== "object" || c.recipient === null || typeof c.recipient !== "object" || c.acknowledged === null || typeof c.acknowledged !== "object") {
    throw new RecipientConfirmationError(
      "missing",
      `${what} needs opts.confirm: { recipient: await checkRecipient(conn, destinationOwner, mint, vault, { wallet }), acknowledged: { recipientWarnings?, mintWarnings?, offCurveConfirmation? } }: the user confirms the recipient before anything is signed`,
    );
  }
  const r = c.recipient;
  const refusals: unknown = r.refusals;
  const recipientWarnings: unknown = r.recipientWarnings;
  const mintWarnings: unknown = r.mintWarnings;
  const offCurveConfirmation: unknown = r.offCurveConfirmation;
  const wallet: unknown = r.wallet;
  if (
    !isStrings(refusals) ||
    !isStrings(recipientWarnings) ||
    !isStrings(mintWarnings) ||
    (offCurveConfirmation !== null && typeof offCurveConfirmation !== "string") ||
    (wallet !== undefined && wallet !== null && !isKey(wallet))
  ) {
    throw new RecipientConfirmationError("missing", "opts.confirm.recipient is not a checkRecipient result");
  }
  const a = c.acknowledged;
  const recipient = Object.freeze({
    ok: r.ok === true,
    refusals: Object.freeze([...refusals]),
    recipientWarnings: Object.freeze([...recipientWarnings]),
    mintWarnings: Object.freeze([...mintWarnings]),
    offCurveConfirmation,
    canonicalAta: copyKey(r.canonicalAta) ?? null,
    destinationOwner: copyKey(r.destinationOwner),
    mint: copyKey(r.mint),
    vault: copyKey(r.vault),
    wallet: copyKey(wallet) ?? null,
  }) as unknown as RecipientCheck;
  const acknowledged = Object.freeze({
    recipientWarnings: a.recipientWarnings === true,
    mintWarnings: a.mintWarnings === true,
    offCurveConfirmation: a.offCurveConfirmation === true,
  });
  return Object.freeze({ recipient, acknowledged });
}

/** The confirmation is for exactly this recipient, mint and vault, refuses nothing, and acknowledges each kind of caution (the SDK's `assertConfirmed`). */
function assertConfirmed(c: RecipientConfirmation, expected: { destinationOwner: PublicKey; mint: PublicKey; vault: PublicKey }): void {
  const r = c.recipient;
  if (!isKey(r.destinationOwner) || !isKey(r.mint) || !isKey(r.vault)) {
    throw new RecipientConfirmationError("mismatch", "the recipient check does not name its recipient, mint and vault (run checkRecipient from this SDK version)");
  }
  const differs = [
    r.destinationOwner.equals(expected.destinationOwner) ? null : `recipient ${r.destinationOwner.toBase58()} (signing for ${expected.destinationOwner.toBase58()})`,
    r.mint.equals(expected.mint) ? null : `mint ${r.mint.toBase58()} (signing for ${expected.mint.toBase58()})`,
    r.vault.equals(expected.vault) ? null : `vault ${r.vault.toBase58()} (signing for ${expected.vault.toBase58()})`,
  ].filter((x) => x !== null);
  if (differs.length > 0) throw new RecipientConfirmationError("mismatch", `the recipient check is for another ${differs.join(", ")}: check this exact withdrawal's recipient`);
  if (r.refusals.length > 0 || r.ok !== true) throw new RecipientConfirmationError("refused", `the recipient check refuses this recipient: ${r.refusals.join(" ")}`);
  const a = c.acknowledged;
  const missing = [
    r.recipientWarnings.length > 0 && a.recipientWarnings !== true ? "recipientWarnings" : null,
    r.mintWarnings.length > 0 && a.mintWarnings !== true ? "mintWarnings" : null,
    r.offCurveConfirmation !== null && a.offCurveConfirmation !== true ? "offCurveConfirmation" : null,
  ].filter((x) => x !== null);
  if (missing.length > 0) {
    const offCurve = r.offCurveConfirmation !== null && missing.includes("offCurveConfirmation") ? `: ${r.offCurveConfirmation}` : "";
    throw new RecipientConfirmationError(
      "unacknowledged",
      `the user has not confirmed the recipient check's ${missing.join(", ")} (set acknowledged.${missing.join(", acknowledged.")} to true only after showing them)${offCurve}`,
    );
  }
}

/** `checkRecipient` again right before signing; anything refused or unseen refuses (the SDK's `recheckRecipient`). */
async function recheckRecipient(c: RecipientConfirmation, expected: { destinationOwner: PublicKey; mint: PublicKey; vault: PublicKey }): Promise<RecipientCheck> {
  await latency("read");
  const r = c.recipient;
  const fresh = checkRecipientNow(chain(), expected.destinationOwner, expected.mint, expected.vault, r.wallet ?? null);
  if (!fresh.ok) throw new RecipientConfirmationError("refused", `the recipient check refuses this recipient now: ${fresh.refusals.join(" ")}`, fresh);
  const unseen = [
    ...fresh.recipientWarnings.filter((w) => !r.recipientWarnings.includes(w)),
    ...fresh.mintWarnings.filter((w) => !r.mintWarnings.includes(w)),
    ...(fresh.offCurveConfirmation !== null && fresh.offCurveConfirmation !== r.offCurveConfirmation ? [fresh.offCurveConfirmation] : []),
  ];
  if (unseen.length > 0) {
    throw new RecipientConfirmationError("stale", `the recipient check changed since the user confirmed it (show error.current and confirm again): ${unseen.join(" ")}`, fresh);
  }
  return fresh;
}

/**
 * The SDK's `assertCluster` on the simulated chain: it serves the cluster
 * the build targets (the genesis hash of that cluster), so it refuses only
 * an unknown cluster and localnet without `allowLocalnet`.
 */
function assertSimulatedCluster(expected: Cluster, opts: AssertClusterOptions): void {
  if (!Object.prototype.hasOwnProperty.call(CLUSTERS, expected)) throw new RangeError(`unknown cluster ${String(expected)}`);
  if (expected === "localnet" && opts.allowLocalnet !== true) {
    throw new ClusterMismatchError("refusing to sign for localnet without allowLocalnet: a localnet label is accepted only when the caller explicitly opts into it", expected, null);
  }
}

function checkMaster(master: Uint8Array): void {
  if (!(master instanceof Uint8Array) || master.length !== 64) throw new RangeError("master must be the 64-byte BIP-39 seed");
  if (master.every((b) => b === 0)) {
    throw new RangeError("refusing an all-zero master seed: it is not the seed of any phrase (was it wiped?), and every key derived from it is public");
  }
}

/** Every local refusal of the SDK's signer (no chain access); returns the parsed message. */
function checkSignable(skSeed: Uint8Array, pk: lmots.LmotsPublicKey, msg: Uint8Array, nextKey: lmots.LmotsPublicKey): ReturnType<typeof parseWithdrawMessage> {
  const parsed = parseWithdrawMessage(msg);
  if (!(skSeed instanceof Uint8Array) || skSeed.length !== lmots.N) throw new Error("refusing to sign: the seed must be 32 bytes");
  if (!bytesEqual(lmots.publicKey({ id: pk.id, q: pk.q, seed: skSeed }).k, pk.k)) throw new Error("refusing to sign: the seed does not match the vault key");
  if (BigInt(pk.q) !== parsed.sequence) {
    throw new Error(`refusing to sign: the message is for sequence ${parsed.sequence}, but this is the key of sequence ${pk.q} (a vault's key at sequence n has q = n)`);
  }
  const wantQ = nextKeyIndex(parsed.sequence);
  if (wantQ === null) throw new Error(`refusing to sign: sequence ${parsed.sequence} is a vault's last; no next key can follow it (InvalidKeyIndex)`);
  const keyId = lmots.keyId(pk);
  if (parsed.nextKeyId.every((b) => b === 0)) throw new Error("refusing to sign: empty next key id");
  if (bytesEqual(parsed.nextKeyId, keyId)) throw new Error("refusing to sign: the next key must be a different key");
  if (!bytesEqual(lmots.keyId(nextKey), parsed.nextKeyId)) {
    throw new Error("refusing to sign: the next key does not hash to the message's next key id (KeyIdMismatch): the withdrawal could never execute");
  }
  if (nextKey.q !== wantQ) {
    throw new Error(
      `refusing to sign: the next key has index q = ${nextKey.q}, but the withdrawal at sequence ${parsed.sequence} must name the key of index ${wantQ} (InvalidKeyIndex): it could never execute`,
    );
  }
  if (parsed.destinationOwner.equals(parsed.vault)) {
    throw new Error("refusing to sign: the recipient is the vault itself, so nothing would be paid; name the wallet that should receive the tokens");
  }
  if (parsed.destinationOwner.equals(PublicKey.default)) throw new Error("refusing to sign: the recipient is the all-zero address");
  return parsed;
}

/** `VaultKeyInUseError` for `record`, arming the session guard with its signature when it verifies under `pk`. */
function inUse(record: VaultKeyRecord, pk: lmots.LmotsPublicKey): VaultKeyInUseError {
  let detail = "";
  try {
    const message = fromHex(record.message);
    const m = parseWithdrawMessage(message);
    detail = ` (max ${m.maxAmount} base units to ${m.destinationOwner.toBase58()}, sequence ${m.sequence})`;
    if (record.signature !== null && lmots.verify(pk, message, fromHex(record.signature))) sawSignature(pk, message);
  } catch {
    detail = "";
  }
  return new VaultKeyInUseError(record, withdrawalFromRecord(record), detail);
}

/** A signed record without its key gets it (authenticated by `importRecord`); best effort. */
async function completeRecordKey(ledger: VaultKeyLedger, rec: VaultKeyRecord | null, pk: lmots.LmotsPublicKey): Promise<VaultKeyRecord | null> {
  if (rec === null || rec.key !== null || rec.signature === null || rec.keyId !== toHex(lmots.keyId(pk))) return rec;
  try {
    await ledger.importRecord({ ...rec, key: { id: toHex(pk.id), q: pk.q, k: toHex(pk.k) } });
    return (await ledger.get(lmots.keyId(pk))) ?? rec;
  } catch {
    return rec;
  }
}

/** The ledger rule around the signature: reserve, then (synchronously after `beforeSign`) sign, record, return. */
async function signRecorded(
  ledger: VaultKeyLedger,
  skSeed: Uint8Array,
  pk: lmots.LmotsPublicKey,
  msg: Uint8Array,
  nextKey: lmots.LmotsPublicKey,
  beforeSign: () => void,
): Promise<{ signature: Uint8Array; reused: boolean }> {
  const parsed = checkSignable(skSeed, pk, msg, nextKey);
  const keyId = lmots.keyId(pk);
  const seen = signedThisSession.get(toHex(keyId));
  if (seen !== undefined && seen !== toHex(msg)) {
    const known = await ledger.get(keyId);
    if (known !== null && known.messageHash !== toHex(sha256(msg))) throw inUse(known, pk);
    throw new Error("refusing to sign: this one-time key already signed a different withdrawal in this session; re-broadcast that stored signature instead");
  }
  const reservation = await ledger.reserve(keyId, msg, { vault: parsed.vault, sequence: parsed.sequence, key: pk });
  const rec = await ledger.get(keyId);
  if (rec === null) throw new VaultLedgerError("the vault-key reservation was not persisted: nothing was signed");
  if (reservation === "conflict" || rec.messageHash !== toHex(sha256(msg))) throw inUse(rec, pk);
  if (rec.signature !== null) {
    const recorded = fromHex(rec.signature);
    if (!lmots.verify(pk, msg, recorded)) throw new VaultLedgerError("the recorded signature does not verify with this key over this withdrawal (another key, or a corrupted record): nothing was signed");
    sawSignature(pk, msg);
    if (rec.nextKey === null) await ledger.recordSignature(keyId, msg, recorded, nextKey);
    await completeRecordKey(ledger, rec, pk);
    return { signature: recorded, reused: true };
  }
  beforeSign();
  checkSignable(skSeed, pk, msg, nextKey);
  const previous = signedThisSession.get(toHex(keyId));
  if (previous !== undefined && previous !== toHex(msg)) {
    throw new Error("refusing to sign: this one-time key already signed a different withdrawal in this session; re-broadcast that stored signature instead");
  }
  signedThisSession.set(toHex(keyId), toHex(msg));
  const signature = mockSignDeterministic(skSeed, pk, msg);
  await ledger.recordSignature(keyId, msg, signature, nextKey);
  return { signature, reused: false };
}

/**
 * The SDK's `prepareWithdrawal` on the simulated chain (see the section
 * comment): ledger and confirmation required, private copies at the call,
 * the confirmation matched before anything is read, the cluster, the vault
 * and the phrase's current key, the ledger's record of that key, the
 * history search, the recipient re-checked, then reserve, sign, record.
 */
export async function prepareWithdrawal(
  conn: Connection,
  master: Uint8Array,
  cluster: Cluster,
  mint: PublicKey,
  account: number,
  request: WithdrawalRequest,
  opts: PrepareWithdrawalOptions,
): Promise<PreparedWithdrawal> {
  const ledger = requireLedger(opts, "prepareWithdrawal");
  const confirm = requireConfirmation(opts, "prepareWithdrawal");
  if (request === null || typeof request !== "object" || !(request.destinationOwner instanceof PublicKey)) throw new TypeError("request.destinationOwner must be a PublicKey");
  if (!(mint instanceof PublicKey)) throw new TypeError("mint must be a PublicKey");
  const destinationOwner = new PublicKey(request.destinationOwner.toBytes());
  const maxAmount: unknown = request.maxAmount;
  if (!isU64(maxAmount)) throw new RangeError("request.maxAmount must be a u64 (bigint base units)");
  const mintKey = new PublicKey(mint.toBytes());
  checkMaster(master);
  const seed = Uint8Array.from(master);
  const secrets: Uint8Array[] = [seed];
  try {
    const genesis = deriveVaultKey(seed, cluster, mintKey, account, GENESIS_KEY_INDEX);
    secrets.push(genesis.skSeed);
    const vaultKey = vaultAddress(mintKey, genesis.keyId);
    const expected = { destinationOwner, mint: mintKey, vault: vaultKey };
    // The user confirmed this exact recipient, mint and vault, before anything is read, reserved or signed.
    assertConfirmed(confirm, expected);
    assertSimulatedCluster(cluster, opts);
    await latency("read");
    const mv = chain().vaults[vaultKey.toBase58()];
    if (mv === undefined) throw new Error(`vault ${vaultKey.toBase58()} (account ${account}) is not open`);
    const vault = vaultInfoOf(chain(), mv);
    const sequence = keySequence(vault.sequence);
    if (nextKeyIndex(vault.sequence) === null) throw new Error("this vault has used its last key sequence: no withdrawal can follow it");
    const key = deriveVaultKey(seed, cluster, mintKey, account, sequence);
    const next = deriveVaultKey(seed, cluster, mintKey, account, sequence + 1);
    secrets.push(key.skSeed, next.skSeed);
    if (!bytesEqual(key.keyId, vault.keyId)) throw new Error("this recovery phrase does not hold the vault's current key: refusing to sign");
    const message = withdrawMessage(vaultKey, mintKey, vault.sequence, destinationOwner, maxAmount, next.keyId);
    const args = (signature: Uint8Array): WithdrawTxArgs => ({ mint: mintKey, vault: vaultKey, sequence: vault.sequence, destinationOwner, maxAmount, signature, nextKey: next.pk, nextKeyId: next.keyId });

    // The durable record of this key comes first.
    const recorded = await completeRecordKey(ledger, await ledger.get(key.keyId), key.pk);
    if (recorded !== null) {
      if (recorded.messageHash !== toHex(sha256(message))) throw inUse(recorded, key.pk);
      if (recorded.signature !== null) {
        const signature = fromHex(recorded.signature);
        if (!lmots.verify(key.pk, message, signature)) {
          throw new VaultLedgerError("the recorded signature does not verify with the vault's current key over this withdrawal (a corrupted record): nothing was signed");
        }
        sawSignature(key.pk, message);
        return { vault, pending: null, signed: { message, args: args(signature), reused: true }, recipient: null, search: null };
      }
    }
    const adopt = async (p: PendingWithdrawal): Promise<PendingWithdrawal> => {
      await ledger.adoptFound(key.keyId, p.message, p.signature, p.nextKey, { vault: vaultKey, sequence: vault.sequence, key: key.pk });
      sawSignature(key.pk, p.message);
      return p;
    };

    const search = await findPendingWithdrawal(conn, vaultKey, opts);
    if (search.vault.sequence !== vault.sequence || !bytesEqual(search.vault.keyId, vault.keyId)) {
      throw new Error(`the vault moved to sequence ${search.vault.sequence} during the history search (a withdrawal executed elsewhere): nothing was signed; prepare it again`);
    }
    if (search.pending !== null) return { vault, pending: await adopt(search.pending), signed: null, recipient: null, search };
    if (search.all.length > 0) {
      const ours = search.all.find((p) => p.nextKey === null && bytesEqual(p.nextKeyId, next.keyId));
      if (ours !== undefined) return { vault, pending: await adopt({ ...ours, nextKey: next.pk, executable: true }), signed: null, recipient: null, search };
      throw new Error(
        `refusing to sign: the vault's current key already signed a withdrawal that cannot execute (transaction ${search.all[0]?.txSignature ?? "?"}); signing another message would be a second one-time signature`,
      );
    }
    if (!search.complete) throw new IncompleteSearchError(search);
    // The chain may have changed since the user confirmed: anything new refuses, before the reservation.
    const recipient = await recheckRecipient(confirm, expected);
    const unchanged = (): void => {
      if (!bytesEqual(master, seed)) throw new Error("refusing to sign: master changed while prepareWithdrawal ran (was it wiped by a lock?); nothing was signed");
    };
    unchanged();
    const { signature, reused } = await signRecorded(ledger, key.skSeed, key.pk, message, next.pk, () => {
      unchanged();
      if (!bytesEqual(lmots.keyId(key.pk), vault.keyId)) throw new Error("refusing to sign: the signing key is not the vault's current key");
      assertConfirmed(confirm, parseWithdrawMessage(message));
    });
    return { vault, pending: null, signed: { message, args: args(signature), reused }, recipient, search };
  } finally {
    for (const x of secrets) x.fill(0);
  }
}

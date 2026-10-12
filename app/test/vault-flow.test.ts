/**
 * The app's withdrawal flow (src/lib/vaultFlow.ts) against the simulated
 * chain, on SDK 0.3.0: checkCluster -> one Web Lock per (cluster, vault,
 * sequence) -> fetchVault -> the key ledger learns what this browser already
 * knew -> prepareWithdrawal (confirmation, cluster, vault, the key ledger,
 * history search, recipient re-check, reserve, sign, record) -> the app's
 * record stored per (vault, sequence) -> broadcast with the release, or
 * alone with the same signature. The audit's C1 (a retry must never become
 * a second signature) and C2 (the recipient must be a wallet) are checked
 * end to end, with the client review's M1 (two tabs: one key ledger), M2 (a
 * lock while signing), L1 (no override of an incomplete search), L2
 * (records that can never execute), L3 (the endpoint's cluster) and L4
 * (separate confirmations).
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { clusterMismatchText, clusterRefusal } from "../src/lib/clusterGate";
import { toHex } from "../src/lib/format";
import type { MetaStore } from "../src/lib/ledger";
import { seedState } from "../src/lib/mock/fixtures";
import { mockSignDeterministic } from "../src/lib/mock/lmotsSigner";
import { addTokens, replaceStateForTests, state } from "../src/lib/mock/store";
import { resetSigningSessionForTests } from "../src/lib/mock/vault";
import * as adapter from "../src/lib/noised";
import type * as T from "../src/lib/noised";
import {
  deleteRetiredWithdrawal,
  deleteWithdrawal,
  exportWithdrawal,
  loadRetiredWithdrawals,
  loadWithdrawals,
  saveNewWithdrawal,
  signingClaimFor,
  withdrawalFor,
  withdrawArgsOf,
  type StoredWithdrawal,
} from "../src/lib/storage";
import {
  cannotExecute,
  confirmationOf,
  importWithdrawalBackup,
  IncompleteBroadcastSearchError,
  planBroadcast,
  recordFromRevealed,
  recordVerdict,
  reviewRecipient,
  RevealedConflictError,
  signingLockName,
  signWithdrawalOnce,
  type Acknowledgments,
  type RecipientReview,
  type SignOptions,
  type SignOutcome,
  type SigningLedgers,
  type VaultChain,
  type WithdrawRequest,
} from "../src/lib/vaultFlow";

const phx = { ...adapter, ...mock };
const conn = new Connection("http://127.0.0.1:8899");
const U64_MAX = (1n << 64n) - 1n;
const CLAIM_PREFIX = "noised.pq.signing.v4:";
const RECORD_PREFIX = "noised.pq.withdrawal.v4:";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  /** Writes to keys with this prefix are silently dropped (a browser that loses data). */
  dropPrefix: string | null = null;
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.dropPrefix !== null && key.startsWith(this.dropPrefix)) return;
    this.map.set(key, value);
  }
}

/** The Web Locks API as one browser profile has it: one lock manager shared by every tab of the origin. */
class FakeLocks {
  private held = new Set<string>();
  readonly requested: string[] = [];
  async request<R>(name: string, options: { mode: string; ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<R>): Promise<R> {
    this.requested.push(name);
    expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

/** App bookkeeping next to the ledger, in memory. */
function memoryMeta(): MetaStore {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) };
}

/** One browser profile's key ledger (every tab of it shares it). */
function browserLedgers(): SigningLedgers {
  return { vaultKeys: phx.createMemoryVaultKeyLedger(), meta: memoryMeta() };
}

let mem: MemoryStorage;
let locks: FakeLocks;
let ledgers: SigningLedgers;
beforeEach(() => {
  replaceStateForTests(seedState());
  mem = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: mem, configurable: true });
  locks = new FakeLocks();
  Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
  ledgers = browserLedgers();
  // Each test is a fresh page load: the signer's one-message-per-key guard of this process starts empty.
  resetSigningSessionForTests();
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis.navigator, "locks");
  vi.useRealTimers();
});

async function land(tx: T.AnyTransaction): Promise<string> {
  const sim = await phx.simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`simulation failed: ${sim.error ?? "?"}`);
  return phx.sendAndConfirm(conn, tx);
}

function demoUser(): PublicKey {
  const user = Keypair.generate().publicKey;
  phx.fundDemoWallet(user);
  return user;
}

interface OpenVault {
  phrase: string;
  master: Uint8Array;
  vault: PublicKey;
  user: PublicKey;
  req: (to: PublicKey, max?: bigint) => WithdrawRequest;
}

/** An open vault of a fresh phrase (account 0) holding `amount` of `mint`. */
async function openVault(mint: PublicKey, amount: bigint, cluster: T.Cluster = "devnet"): Promise<OpenVault> {
  const user = demoUser();
  const phrase = phx.generateRecoveryPhrase();
  const master = phx.masterFromPhrase(phrase);
  const genesis = phx.deriveVaultKey(master, cluster, mint, 0, 0);
  const vault = phx.vaultAddress(mint, genesis.keyId);
  await land(await phx.buildOpenVaultTx(conn, user, mint, genesis.pk));
  if (amount > 0n) addTokens(state(), vault, mint, amount);
  const req = (to: PublicKey, max = U64_MAX): WithdrawRequest => ({ cluster, mint, account: 0, vault, destinationOwner: to, maxAmount: max });
  return { phrase, master, vault, user, req };
}

const dUsd = (): PublicKey => {
  const m = phx.demoMints()[0];
  if (!m) throw new Error("demo mint missing");
  return m.address;
};

const ALL: Acknowledgments = { recipientWarnings: true, mintWarnings: true, offCurveConfirmation: true };

/** Every confirmation a review asks for, given (each kind acknowledged on its own). */
function confirmAll(r: RecipientReview, acks: Acknowledgments = ALL): SignOptions {
  return { reviewedSequence: r.vault.sequence, confirm: confirmationOf(r.check, acks) };
}

async function signNow(chain: VaultChain, master: Uint8Array, req: WithdrawRequest, extra: Partial<SignOptions> = {}, l: SigningLedgers = ledgers): Promise<SignOutcome> {
  const review = await reviewRecipient(chain, conn, req);
  return signWithdrawalOnce(chain, conn, master, req, l, { ...confirmAll(review), ...extra });
}

/** The key id of the phrase's vault key at `sequence`. */
function keyIdAt(master: Uint8Array, mint: PublicKey, sequence: number): Uint8Array {
  const k = phx.deriveVaultKey(master, "devnet", mint, 0, sequence);
  k.skSeed.fill(0);
  return k.keyId;
}

/** A record of (vault, 0) signed with LM-OTS by `key` outside any ledger (another device's, another phrase's, a forger's): a test-local signer. */
function recordBy(o: { vault: PublicKey; mint: PublicKey; key: T.VaultKeyMaterial; next: T.VaultKeyMaterial; to: PublicKey; max: bigint; cluster?: T.Cluster }): StoredWithdrawal {
  const msg = phx.withdrawMessage(o.vault, o.mint, 0n, o.to, o.max, o.next.keyId);
  const sig = mockSignDeterministic(o.key.skSeed, o.key.pk, msg);
  return {
    version: 4,
    mode: "mock",
    cluster: o.cluster ?? "devnet",
    vault: o.vault.toBase58(),
    mint: o.mint.toBase58(),
    account: 0,
    sequence: "0",
    key: { id: toHex(o.key.pk.id), q: o.key.pk.q, k: toHex(o.key.pk.k) },
    nextKey: { id: toHex(o.next.pk.id), q: o.next.pk.q, k: toHex(o.next.pk.k) },
    destinationOwner: o.to.toBase58(),
    maxAmount: o.max.toString(),
    message: toHex(msg),
    signature: toHex(sig),
    source: "signed",
    feePayerSecret: toHex(Keypair.generate().secretKey),
    feePayerRefunded: false,
    status: "signed",
    lastIncludedRelease: null,
    lastTxSignature: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("signing (fetchVault -> key ledger -> prepareWithdrawal -> store)", () => {
  it("signs once through the key ledger, stores the record and reads it back; a retry returns the same signature (C1)", async () => {
    const mint = dUsd();
    const { master, vault, req } = await openVault(mint, 50n);
    const to = Keypair.generate().publicKey;
    const review = await reviewRecipient(mock, conn, req(to, 20n));
    expect(review.vault.sequence).toBe(0n);
    expect(review.check).toMatchObject({ ok: true, recipientWarnings: [], destinationOwner: to, mint, vault });
    // dUSD has a freeze authority: a token warning, which must be confirmed.
    expect(review.check.mintWarnings.join(" ")).toMatch(/Freeze authority/);

    const first = await signWithdrawalOnce(mock, conn, master, req(to, 20n), ledgers, confirmAll(review));
    if (first.kind !== "stored") throw new Error(`unexpected ${first.kind}`);
    expect(first.signedNow).toBe(true);
    expect(first.record).toMatchObject({ version: 4, mode: "mock", account: 0, sequence: "0", source: "signed", status: "signed", maxAmount: "20", destinationOwner: to.toBase58() });
    expect(mem.getItem(`${RECORD_PREFIX}${vault.toBase58()}:0`)).toBe(JSON.stringify(first.record));
    // The key ledger holds the key of sequence 0, signed for exactly this message, naming the key of sequence 1.
    const held = await ledgers.vaultKeys.get(keyIdAt(master, mint, 0));
    expect(held).toMatchObject({ status: "signed", signature: first.record.signature, message: first.record.message, origin: "signed" });
    expect(first.record.nextKey.k).toBe(toHex(phx.deriveVaultKey(master, "devnet", mint, 0, 1).pk.k));
    expect(locks.requested).toContain(signingLockName("devnet", vault, 0n));
    // No legacy signing claim is written any more: the ledger reserved the key.
    expect(signingClaimFor(vault, 0n)).toBeNull();

    // A retry (same message) never makes a second signature: the ledger's.
    const retry = await signNow(mock, master, req(to, 20n));
    expect(retry).toMatchObject({ kind: "stored", signedNow: false });
    if (retry.kind === "stored") expect(retry.record.signature).toBe(first.record.signature);
    // A different message for the same key is refused, whatever the recipient or amount: re-broadcast the signed one.
    for (const other of [req(Keypair.generate().publicKey, 20n), req(to, 21n)]) {
      const o = await signNow(mock, master, other);
      if (o.kind !== "in-use") throw new Error(`unexpected ${o.kind}`);
      expect(toHex(o.withdrawal.signature)).toBe(first.record.signature);
      expect(o.withdrawal.destinationOwner.equals(to)).toBe(true);
    }
    expect(loadWithdrawals()).toHaveLength(1);
  });

  it("refuses recipients that would lose the payout before touching the key (C2)", async () => {
    const mint = (await launchBySymbol("MRDN")).baseMint;
    const { master, vault, user, req } = await openVault(mint, 10n);
    const bad = [
      vault,
      mint,
      phx.associatedTokenAddress(user, mint, phx.KNOWN_ACCOUNTS.token2022),
      PublicKey.default,
      // The vault's own token account (its deposit address) and its payout addresses.
      phx.associatedTokenAddress(vault, mint, phx.KNOWN_ACCOUNTS.token2022),
      phx.payoutAddress(vault, 0n),
      phx.payoutAddress(vault, 3n),
    ];
    for (const who of bad) {
      const review = await reviewRecipient(mock, conn, req(who));
      expect(review.check.ok, who.toBase58()).toBe(false);
      const o = await signWithdrawalOnce(mock, conn, master, req(who), ledgers, confirmAll(review));
      expect(o).toMatchObject({ kind: "refused", code: "recipient" });
    }
    expect(loadWithdrawals()).toEqual([]);
    expect(await ledgers.vaultKeys.list()).toEqual([]);
    // The key never signed: a valid recipient can still be signed for.
    expect((await signNow(mock, master, req(Keypair.generate().publicKey))).kind).toBe("stored");
  });

  it("re-broadcasts a signature already revealed on chain instead of signing (a cleared browser, another device)", async () => {
    const bastion = await launchBySymbol("BSTN");
    const { master, vault, user, req } = await openVault(bastion.baseMint, 5_000n);
    const to = Keypair.generate().publicKey;
    const signed = await signNow(mock, master, req(to, 1_000n));
    if (signed.kind !== "stored") throw new Error(`unexpected ${signed.kind}`);
    // Sent as withdraw + release during the Launch Guard's p2p lock: it lands and fails, revealing the signature.
    const feePayer = Keypair.generate();
    await land(await phx.buildFundFeePayerTx(conn, user, feePayer.publicKey, phx.FEE_PAYER_FUNDING_LAMPORTS));
    const args = { ...withdrawArgsOf(signed.record), includeRelease: true };
    await expect(phx.sendAndConfirm(conn, (await phx.buildWithdrawTx(conn, feePayer, args)).tx)).rejects.toThrow(/TransfersLocked/);

    // Another browser (empty storage, its own empty ledger, a fresh page): signing for another recipient must not happen.
    mem.clear();
    resetSigningSessionForTests();
    const elsewhere = browserLedgers();
    const again = await signNow(mock, master, req(Keypair.generate().publicKey, 999n), {}, elsewhere);
    if (again.kind !== "revealed") throw new Error(`unexpected ${again.kind}`);
    expect(again.record.signature).toBe(signed.record.signature);
    expect(again.record).toMatchObject({ source: "revealed", status: "failed", destinationOwner: to.toBase58(), maxAmount: "1000", sequence: "0" });
    expect(withdrawalFor(vault, 0n)?.signature).toBe(signed.record.signature);
    // That browser's ledger now holds the found signature too (origin "found"), so it never signs another message with the key.
    expect(await elsewhere.vaultKeys.get(keyIdAt(master, bastion.baseMint, 0))).toMatchObject({ origin: "found", signature: signed.record.signature });
  });

  it("never signs when the phrase does not hold the vault's current key, or the vault is not one of its accounts", async () => {
    const { master, vault, req } = await openVault(dUsd(), 10n);
    const v = state().vaults[vault.toBase58()];
    if (!v) throw new Error("missing");
    // The vault was handed to a key from elsewhere (another client named it as the next key).
    const foreign = phx.deriveVaultKey(phx.masterFromPhrase(phx.generateRecoveryPhrase()), "devnet", dUsd(), 0, 0);
    v.key = foreign.pk;
    v.keyId = foreign.keyId;
    const to = Keypair.generate().publicKey;
    expect(await signNow(mock, master, req(to))).toMatchObject({ kind: "refused", code: "key" });
    expect(loadWithdrawals()).toEqual([]);
    // Nor for an account of another phrase.
    const stranger = phx.masterFromPhrase(phx.generateRecoveryPhrase());
    expect(await signNow(mock, stranger, req(to))).toMatchObject({ kind: "refused", code: "vault" });
    expect(await ledgers.vaultKeys.list()).toEqual([]);
  });

  it("stops when the vault moved since the review; a signature the browser could not save stays in the key ledger and is returned again", async () => {
    const mint = dUsd();
    const { master, vault, req } = await openVault(mint, 10n);
    const to = Keypair.generate().publicKey;
    const review = await reviewRecipient(mock, conn, req(to));
    const v = state().vaults[vault.toBase58()];
    if (!v) throw new Error("missing");
    v.sequence = 1n;
    expect(await signWithdrawalOnce(mock, conn, master, req(to), ledgers, confirmAll(review))).toMatchObject({ kind: "refused", code: "moved" });
    v.sequence = 0n;

    mem.dropPrefix = RECORD_PREFIX;
    const unsaved = await signNow(mock, master, req(to));
    if (unsaved.kind !== "unsaved") throw new Error(`unexpected ${unsaved.kind}`);
    expect(unsaved.error).toMatch(/did not store/);
    expect(phx.lmots.verify(phx.deriveVaultKey(master, "devnet", mint, 0, 0).pk, hex(unsaved.record.message), hex(unsaved.record.signature))).toBe(true);
    // The key ledger has it: another message is refused, the same one comes back identical and is stored.
    mem.dropPrefix = null;
    expect(await signNow(mock, master, req(Keypair.generate().publicKey))).toMatchObject({ kind: "in-use" });
    const finished = await signNow(mock, master, req(to));
    if (finished.kind !== "stored") throw new Error(`unexpected ${finished.kind}`);
    expect(finished).toMatchObject({ signedNow: false });
    expect(finished.record.signature).toBe(unsaved.record.signature);
  });
});

describe("one key ledger for every tab of a browser (M1: one one-time key, one message)", () => {
  it("another tab's reservation that lands during the checks is found before signing: nothing is signed", async () => {
    // Port of the review's race: tab A reserves the key while tab B awaits its checks; both share the profile's ledger.
    const mint = dUsd();
    const { master, vault, req } = await openVault(mint, 100n);
    const k0 = phx.deriveVaultKey(master, "devnet", mint, 0, 0);
    const k1 = phx.deriveVaultKey(master, "devnet", mint, 0, 1);
    const alice = Keypair.generate().publicKey;
    const messageA = phx.withdrawMessage(vault, mint, 0n, alice, 10n, k1.keyId);
    const tabB: VaultChain = {
      ...mock,
      prepareWithdrawal: async (...a) => {
        await ledgers.vaultKeys.reserve(k0.keyId, messageA, { vault, sequence: 0n, key: k0.pk });
        return mock.prepareWithdrawal(...a);
      },
    };
    const bob = Keypair.generate().publicKey;
    const outcome = await signNow(tabB, master, req(bob));
    expect(outcome).toMatchObject({ kind: "reserved", maxAmount: 10n });
    if (outcome.kind === "reserved") expect(outcome.destinationOwner.equals(alice)).toBe(true);
    // B never signed: the key is reserved for A's message only, with no signature.
    expect(await ledgers.vaultKeys.get(k0.keyId)).toMatchObject({ status: "reserved", signature: null, message: toHex(messageA) });
    expect(loadWithdrawals()).toEqual([]);
    // Finishing A's withdrawal (the same message) signs it.
    expect((await signNow(mock, master, req(alice, 10n))).kind).toBe("stored");
  });

  it("only one tab at a time signs for a (cluster, vault, sequence): the other is refused, then the ledger refuses its message", async () => {
    const { master, vault, req } = await openVault(dUsd(), 100n);
    const alice = Keypair.generate().publicKey;
    const bob = Keypair.generate().publicKey;
    const [ra, rb] = await Promise.all([reviewRecipient(mock, conn, req(alice)), reviewRecipient(mock, conn, req(bob))]);
    const [a, b] = await Promise.all([
      signWithdrawalOnce(mock, conn, master, req(alice), ledgers, confirmAll(ra)),
      signWithdrawalOnce(mock, conn, master, req(bob), ledgers, confirmAll(rb)),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["refused", "stored"]);
    expect(a.kind === "refused" ? a : b).toMatchObject({ kind: "refused", code: "busy" });
    expect(loadWithdrawals()).toHaveLength(1);
    // Once the lock is free, the refused tab's message is refused by the shared ledger: still nothing new is signed.
    const later = a.kind === "refused" ? await signNow(mock, master, req(alice)) : await signNow(mock, master, req(bob));
    expect(later.kind).toBe("in-use");
    expect(locks.requested.every((n) => n === signingLockName("devnet", vault, 0n))).toBe(true);
  });

  it("refuses to sign without the Web Locks API, and while an import left keys it cannot check", async () => {
    const { master, req } = await openVault(dUsd(), 100n);
    const to = Keypair.generate().publicKey;
    Reflect.deleteProperty(globalThis.navigator, "locks");
    expect(await signNow(mock, master, req(to))).toMatchObject({ kind: "refused", code: "locks" });
    Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
    await ledgers.meta.put("vault-keys/unverifiable", ["ab".repeat(32)]);
    expect(await signNow(mock, master, req(to))).toMatchObject({ kind: "refused", code: "unverifiable" });
    expect(await ledgers.vaultKeys.list()).toEqual([]);
    await ledgers.meta.put("vault-keys/unverifiable", []);
    expect((await signNow(mock, master, req(to))).kind).toBe("stored");
  });

  it("an unfinished signing of an older version (a legacy claim) becomes a reservation: only its message may be signed", async () => {
    const mint = dUsd();
    const { master, vault, req } = await openVault(mint, 100n);
    const carol = Keypair.generate().publicKey;
    const k1 = phx.deriveVaultKey(master, "devnet", mint, 0, 1);
    const claimed = phx.withdrawMessage(vault, mint, 0n, carol, 4n, k1.keyId);
    mem.setItem(
      `${CLAIM_PREFIX}${vault.toBase58()}:0`,
      JSON.stringify({ version: 4, cluster: "devnet", vault: vault.toBase58(), mint: mint.toBase58(), account: 0, sequence: "0", message: toHex(claimed), createdAt: 1 }),
    );
    const o = await signNow(mock, master, req(Keypair.generate().publicKey));
    expect(o).toMatchObject({ kind: "reserved", maxAmount: 4n });
    // Moved into the ledger (and out of localStorage).
    expect(signingClaimFor(vault, 0n)).toBeNull();
    expect(await ledgers.vaultKeys.get(keyIdAt(master, mint, 0))).toMatchObject({ status: "reserved", message: toHex(claimed) });
    expect((await signNow(mock, master, req(carol, 4n))).kind).toBe("stored");
  });

  it("an older version's signed record is moved into the ledger before signing: its key never signs another message", async () => {
    const mint = dUsd();
    const { master, vault, req } = await openVault(mint, 100n);
    const mine = recordBy({ vault, mint, key: phx.deriveVaultKey(master, "devnet", mint, 0, 0), next: phx.deriveVaultKey(master, "devnet", mint, 0, 1), to: Keypair.generate().publicKey, max: 3n });
    // Even with a damaged key field: its signature still verifies with the vault's key.
    saveNewWithdrawal({ ...mine, key: { ...mine.key, k: "00".repeat(32) } });
    const o = await signNow(mock, master, req(Keypair.generate().publicKey));
    if (o.kind !== "in-use") throw new Error(`unexpected ${o.kind}`);
    expect(toHex(o.withdrawal.signature)).toBe(mine.signature);
    expect(await ledgers.vaultKeys.get(keyIdAt(master, mint, 0))).toMatchObject({ signature: mine.signature });
    expect(loadRetiredWithdrawals()).toEqual([]);
  });
});

describe("the key locked while signing (M2)", () => {
  /** A ledger that runs `onGet` the first time the signer reads it (in the middle of the checks). */
  function wiping(onGet: () => void): SigningLedgers {
    const inner = phx.createMemoryVaultKeyLedger();
    let fired = false;
    return {
      meta: memoryMeta(),
      vaultKeys: {
        ...inner,
        get: async (id) => {
          if (!fired) {
            fired = true;
            onGet();
          }
          return inner.get(id);
        },
        reserve: (...a) => inner.reserve(...a),
        list: () => inner.list(),
        recordSignature: (...a) => inner.recordSignature(...a),
        adoptFound: (...a) => inner.adoptFound(...a),
        importRecord: (r) => inner.importRecord(r),
      },
    };
  }

  it("a master wiped during the checks signs nothing and reserves nothing; the phrase signs later with the vault's real keys", async () => {
    // Port of the review's lock-midflight reproduction: "Lock" wipes the master while the signer checks.
    const mint = dUsd();
    const { phrase, master, vault, req } = await openVault(mint, 100n);
    const l = wiping(() => master.fill(0));
    const to = Keypair.generate().publicKey;
    expect(await signNow(mock, master, req(to, 10n), {}, l)).toMatchObject({ kind: "refused", code: "locked" });
    expect(loadWithdrawals()).toEqual([]);
    expect(await l.vaultKeys.list()).toEqual([]);
    // A wiped master is refused at once, before any chain read.
    const reads = vi.fn();
    const counted: VaultChain = { ...mock, fetchVault: async (c, v) => (reads(), mock.fetchVault(c, v)), checkCluster: async (c, e) => (reads(), mock.checkCluster(c, e)) };
    const review = await reviewRecipient(mock, conn, req(to, 10n));
    expect(await signWithdrawalOnce(counted, conn, master, req(to, 10n), ledgers, confirmAll(review))).toMatchObject({ kind: "refused", code: "locked" });
    expect(reads).not.toHaveBeenCalled();

    // Unlocked again: the key of sequence 0 signs, naming the phrase's key of sequence 1 (never a zero-master key).
    const again = phx.masterFromPhrase(phrase);
    const o = await signNow(mock, again, req(to, 10n));
    if (o.kind !== "stored") throw new Error(`unexpected ${o.kind}`);
    expect(o.record.key.k).toBe(toHex(phx.deriveVaultKey(again, "devnet", mint, 0, 0).pk.k));
    expect(o.record.nextKey.k).toBe(toHex(phx.deriveVaultKey(again, "devnet", mint, 0, 1).pk.k));
    expect(withdrawalFor(vault, 0n)?.signature).toBe(o.record.signature);
  });

  it("a master replaced by another phrase's seed during the checks signs nothing", async () => {
    const { master, req } = await openVault(dUsd(), 100n);
    const other = phx.masterFromPhrase(phx.generateRecoveryPhrase());
    const l = wiping(() => master.set(other));
    expect(await signNow(mock, master, req(Keypair.generate().publicKey), {}, l)).toMatchObject({ kind: "refused", code: "locked" });
    expect(loadWithdrawals()).toEqual([]);
    expect(await l.vaultKeys.list()).toEqual([]);
  });
});

describe("an incomplete history search is never overridden (L1)", () => {
  it("signs nothing until the search completes; continuing it then signs", async () => {
    const { master, req } = await openVault(dUsd(), 10n);
    const continuation: T.PendingWithdrawalContinuation = Object.freeze({ vault: req(PublicKey.default).vault, sequence: 0n, examined: 1_000 });
    const asked: (T.PendingWithdrawalContinuation | undefined)[] = [];
    const paged: VaultChain = {
      ...mock,
      prepareWithdrawal: async (c, m, cl, mint, account, request, opts) => {
        asked.push(opts.continueFrom ?? undefined);
        if (opts.continueFrom !== continuation) {
          const full = await mock.findPendingWithdrawal(c, req(PublicKey.default).vault);
          throw new phx.IncompleteSearchError({ ...full, complete: false, incompleteReason: "limit", continuation, note: "The search stopped at this call's limit." });
        }
        // The simulated chain's search always completes: continued, it is that complete search.
        return mock.prepareWithdrawal(c, m, cl, mint, account, request, { ...opts, continueFrom: null });
      },
    };
    const to = Keypair.generate().publicKey;
    const first = await signNow(paged, master, req(to));
    if (first.kind !== "incomplete") throw new Error(`unexpected ${first.kind}`);
    expect(first.search.continuation).toBe(continuation);
    expect(loadWithdrawals()).toEqual([]);
    expect(await ledgers.vaultKeys.list()).toEqual([]);
    // The former override is gone: an extra option changes nothing.
    const legacy = await signNow(paged, master, req(to), { allowIncompleteSearch: true } as unknown as Partial<SignOptions>);
    expect(legacy.kind).toBe("incomplete");
    // Continuing the search (the UI's "Continue searching") completes it, then signs.
    const done = await signNow(paged, master, req(to), { continueFrom: first.search.continuation });
    expect(done.kind).toBe("stored");
    expect(asked.at(-1)).toBe(continuation);
  });

  it("planBroadcast stops before building when the search is incomplete, until the user confirms or the search completes", async () => {
    const mint = (await launchBySymbol("MRDN")).baseMint;
    const { master, user, req } = await openVault(mint, 100n);
    const o = await signNow(mock, master, req(Keypair.generate().publicKey, 40n));
    if (o.kind !== "stored") throw new Error(`unexpected ${o.kind}`);
    await land(await phx.buildFundFeePayerTx(conn, user, feePayerKey(o.record), phx.FEE_PAYER_FUNDING_LAMPORTS));
    const continuation: T.PendingWithdrawalContinuation = Object.freeze({ vault: new PublicKey(o.record.vault), sequence: 0n, examined: 1_000 });
    const builds = vi.fn();
    const paged: VaultChain = {
      ...mock,
      findPendingWithdrawal: async (c, v, opts) => {
        const full = await mock.findPendingWithdrawal(c, v);
        return opts?.continueFrom === continuation ? full : { ...full, complete: false, incompleteReason: "limit", continuation, note: "stopped at the limit" };
      },
      buildWithdrawTxWithFallback: async (...a) => {
        builds();
        return mock.buildWithdrawTxWithFallback(...a);
      },
    };
    const err = await planBroadcast(paged, conn, o.record, ledgers.vaultKeys).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteBroadcastSearchError);
    expect((err as IncompleteBroadcastSearchError).search.continuation).toBe(continuation);
    expect(builds).not.toHaveBeenCalled();
    expect((await planBroadcast(paged, conn, o.record, ledgers.vaultKeys, { continueFrom: continuation })).searchNote).toBeNull();
    expect((await planBroadcast(paged, conn, o.record, ledgers.vaultKeys, { broadcastDespiteIncompleteSearch: true })).searchNote).toBe("stopped at the limit");
    expect(builds).toHaveBeenCalledTimes(2);
  });
});

describe("records that can never execute (L2)", () => {
  /** A forger's withdrawal naming the user's vault, signed with the forger's own key (port of the review's dead-record reproduction). */
  function forged(vault: PublicKey, mint: PublicKey): StoredWithdrawal {
    const evil = phx.masterFromPhrase(phx.generateRecoveryPhrase());
    return {
      ...recordBy({ vault, mint, key: phx.deriveVaultKey(evil, "devnet", mint, 0, 0), next: phx.deriveVaultKey(evil, "devnet", mint, 0, 1), to: Keypair.generate().publicKey, max: 1n }),
      mode: "live",
    };
  }

  it("a backup the vault's key did not sign is refused at import", async () => {
    const mint = dUsd();
    const { vault } = await openVault(mint, 100n);
    await expect(importWithdrawalBackup(mock, conn, exportWithdrawal(forged(vault, mint)), "devnet", ledgers.vaultKeys)).rejects.toThrow(/not signed by the key of vault .*Nothing was imported/);
    expect(loadWithdrawals()).toEqual([]);
    expect(await ledgers.vaultKeys.list()).toEqual([]);
  });

  it("a stored record of another key is archived when the vault's key signs, and can be removed", async () => {
    const mint = dUsd();
    const { master, vault, req } = await openVault(mint, 100n);
    const dead = forged(vault, mint);
    saveNewWithdrawal(dead);
    expect((await recordVerdict(mock, conn, dead)).kind).toBe("dead");
    expect(cannotExecute(await recordVerdict(mock, conn, dead))).toBe(true);
    const o = await signNow(mock, master, req(Keypair.generate().publicKey, 10n));
    if (o.kind !== "stored") throw new Error(`unexpected ${o.kind}`);
    expect(withdrawalFor(vault, 0n)?.signature).toBe(o.record.signature);
    const archived = loadRetiredWithdrawals();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ kind: "archived", vault: vault.toBase58() });
    expect(archived[0]?.reason).toMatch(/its key is not the key of vault/);
    deleteRetiredWithdrawal(archived[0]?.storageKey ?? "");
    expect(loadRetiredWithdrawals()).toEqual([]);
  });

  it("imports a backup only for this cluster and a vault waiting at its sequence; its key is then used in the ledger", async () => {
    const mint = dUsd();
    const { master, vault, user, req } = await openVault(mint, 100n);
    const k0 = phx.deriveVaultKey(master, "devnet", mint, 0, 0);
    const k1 = phx.deriveVaultKey(master, "devnet", mint, 0, 1);
    const good = recordBy({ vault, mint, key: k0, next: k1, to: user, max: 5n });
    await expect(importWithdrawalBackup(mock, conn, exportWithdrawal({ ...good, cluster: "mainnet" }), "devnet", ledgers.vaultKeys)).rejects.toThrow(/This backup is for mainnet/);
    const elsewhere = Keypair.generate().publicKey;
    await expect(importWithdrawalBackup(mock, conn, exportWithdrawal(recordBy({ vault: elsewhere, mint, key: k0, next: k1, to: user, max: 5n })), "devnet", ledgers.vaultKeys)).rejects.toThrow(/There is no vault/);
    // A dead record in the slot is archived to make room for the vault key's own withdrawal.
    saveNewWithdrawal(forged(vault, mint));
    const imported = await importWithdrawalBackup(mock, conn, exportWithdrawal(good), "devnet", ledgers.vaultKeys);
    expect(imported).toMatchObject({ source: "imported", signature: good.signature });
    expect(withdrawalFor(vault, 0n)?.signature).toBe(good.signature);
    expect(loadRetiredWithdrawals()).toHaveLength(1);
    expect(await ledgers.vaultKeys.get(k0.keyId)).toMatchObject({ origin: "imported", signature: good.signature });
    // This browser now knows the key is used: it signs nothing else with it.
    expect((await signNow(mock, master, req(Keypair.generate().publicKey))).kind).toBe("in-use");
    await expect(importWithdrawalBackup(mock, conn, exportWithdrawal(good), "devnet", ledgers.vaultKeys)).rejects.toThrow(/already holds this signed withdrawal/);
    // Once the vault moved past the sequence, the backup can never execute.
    deleteWithdrawal(vault.toBase58(), 0n);
    const v = state().vaults[vault.toBase58()];
    if (!v) throw new Error("missing");
    v.sequence = 1n;
    await expect(importWithdrawalBackup(mock, conn, exportWithdrawal(good), "devnet", ledgers.vaultKeys)).rejects.toThrow(/sequence 0 was already used/);
  });
});

describe("the RPC endpoint must serve this build's cluster (L3)", () => {
  const live = (s: "match" | "mismatch" | "unverified" | "error"): VaultChain => ({
    ...mock,
    mode: "live",
    checkCluster: async () => ({ state: s, genesisHash: s === "error" ? null : "x", detail: `endpoint ${s}` }),
  });

  it("signs nothing unless the endpoint's genesis hash is the cluster's", async () => {
    const { master, req } = await openVault(dUsd(), 10n);
    const to = Keypair.generate().publicKey;
    for (const s of ["mismatch", "error", "unverified"] as const) expect(await signNow(live(s), master, req(to)), s).toMatchObject({ kind: "refused", code: "network" });
    expect(loadWithdrawals()).toEqual([]);
    expect((await signNow(live("match"), master, req(to))).kind).toBe("stored");
  });

  it("accepts an unverified endpoint only in a localnet build, the simulated chain included", async () => {
    const { master, req } = await openVault(dUsd(), 10n, "localnet");
    expect((await signNow(live("unverified"), master, req(Keypair.generate().publicKey))).kind).toBe("stored");
    const check = (s: "match" | "mismatch" | "unverified" | "error"): T.ClusterCheck => ({ state: s, genesisHash: null, detail: "d" });
    expect(clusterRefusal(null, "devnet", "live")).toMatch(/not been checked/);
    expect(clusterRefusal(null, "devnet", "mock")).toMatch(/not been checked/);
    expect(clusterRefusal(check("match"), "mainnet", "live")).toBeNull();
    expect(clusterRefusal(check("mismatch"), "devnet", "live")).toBe("d");
    expect(clusterRefusal(check("error"), "devnet", "live")).toMatch(/could not be checked/);
    expect(clusterRefusal(check("unverified"), "devnet", "live")).toMatch(/could not be verified/);
    expect(clusterRefusal(check("unverified"), "localnet", "live")).toBeNull();
    // The simulated chain reports the cluster it stands for; "unverified" is refused there too outside localnet.
    expect(clusterRefusal(check("unverified"), "devnet", "mock")).toMatch(/could not be verified/);
    expect(await mock.checkCluster(conn, "devnet")).toMatchObject({ state: "match" });
    expect(await mock.checkCluster(conn, "localnet")).toMatchObject({ state: "unverified" });
  });

  it("surfaces the signer's own cluster refusal (ClusterMismatchError) in plain words", async () => {
    const { master, req } = await openVault(dUsd(), 10n);
    const mismatch = new phx.ClusterMismatchError("refusing to sign: keys for devnet, but the endpoint serves mainnet", "devnet", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    const refusing: VaultChain = {
      ...mock,
      prepareWithdrawal: async () => {
        throw mismatch;
      },
    };
    const o = await signNow(refusing, master, req(Keypair.generate().publicKey));
    expect(o).toMatchObject({ kind: "refused", code: "network" });
    if (o.kind === "refused") expect(o.reason).toBe(clusterMismatchText(mismatch));
    expect(clusterMismatchText(mismatch)).toMatch(/This app signs for devnet, but the network connection is mainnet .*Nothing was signed/);
    expect(clusterMismatchText(new Error("x"))).toBeNull();
  });
});

describe("each kind of caution has its own confirmation (L4)", () => {
  it("recipient warnings and token warnings are confirmed separately", async () => {
    const mint = dUsd();
    const { master, req } = await openVault(mint, 100n);
    const to = demoUser();
    state().frozen[`${to.toBase58()}:${mint.toBase58()}`] = true;
    const review = await reviewRecipient(mock, conn, req(to));
    expect(review.check.recipientWarnings.join(" ")).toMatch(/it is frozen/);
    expect(review.check.mintWarnings.join(" ")).toMatch(/Freeze authority/);
    const sign = (acks: Acknowledgments): Promise<SignOutcome> => signWithdrawalOnce(mock, conn, master, req(to), ledgers, confirmAll(review, acks));
    expect(await sign({ ...ALL, recipientWarnings: false })).toMatchObject({ kind: "refused", code: "confirm" });
    expect(await sign({ ...ALL, mintWarnings: false })).toMatchObject({ kind: "refused", code: "confirm" });
    expect(await ledgers.vaultKeys.list()).toEqual([]);
    expect((await sign(ALL)).kind).toBe("stored");
  });

  it("an off-curve recipient with no account needs its own explicit confirmation", async () => {
    const { master, req } = await openVault(dUsd(), 100n);
    const pda = PublicKey.findProgramAddressSync([new TextEncoder().encode("never used")], Keypair.generate().publicKey)[0];
    const review = await reviewRecipient(mock, conn, req(pda));
    expect(review.check.ok).toBe(true);
    expect(review.check.offCurveConfirmation).toMatch(/payout is lost forever/);
    // The warnings acknowledged are not the off-curve confirmation.
    const without = await signWithdrawalOnce(mock, conn, master, req(pda), ledgers, confirmAll(review, { ...ALL, offCurveConfirmation: false }));
    expect(without).toMatchObject({ kind: "refused", code: "confirm" });
    expect(loadWithdrawals()).toEqual([]);
    expect((await signWithdrawalOnce(mock, conn, master, req(pda), ledgers, confirmAll(review))).kind).toBe("stored");
  });

  it("a caution that appears after the review refuses (stale), with the fresh check to confirm", async () => {
    const mint = dUsd();
    const { master, req } = await openVault(mint, 100n);
    const to = demoUser();
    const review = await reviewRecipient(mock, conn, req(to));
    expect(review.check.recipientWarnings).toEqual([]);
    // The recipient's account is frozen after the user confirmed: a recipient warning the user never saw.
    state().frozen[`${to.toBase58()}:${mint.toBase58()}`] = true;
    const o = await signWithdrawalOnce(mock, conn, master, req(to), ledgers, confirmAll(review));
    expect(o).toMatchObject({ kind: "refused", code: "stale" });
    if (o.kind === "refused") expect(o.check?.recipientWarnings.join(" ")).toMatch(/it is frozen/);
    expect(await ledgers.vaultKeys.list()).toEqual([]);
    // Confirmed again with the fresh check: signed.
    if (o.kind !== "refused" || o.check === null) throw new Error("no fresh check");
    expect((await signWithdrawalOnce(mock, conn, master, req(to), ledgers, { reviewedSequence: 0n, confirm: confirmationOf(o.check, ALL) })).kind).toBe("stored");
  });

  it("the connected wallet's own token account is refused even before it exists", async () => {
    const mint = dUsd();
    const { master, req } = await openVault(mint, 100n);
    const wallet = Keypair.generate().publicKey;
    const ata = phx.associatedTokenAddress(wallet, mint, phx.KNOWN_ACCOUNTS.splToken);
    expect((await reviewRecipient(mock, conn, req(ata))).check.offCurveConfirmation).not.toBeNull();
    const withWallet = { ...req(ata), wallet };
    const review = await reviewRecipient(mock, conn, withWallet);
    expect(review.check.ok).toBe(false);
    expect(review.check.refusals.join(" ")).toMatch(/your connected wallet's own token account/);
    expect(await signWithdrawalOnce(mock, conn, master, withWallet, ledgers, confirmAll(review))).toMatchObject({ kind: "refused", code: "recipient" });
  });
});

describe("broadcast (withdraw + release, or the withdrawal alone with the same signature)", () => {
  it("includes the release when it can succeed, then reports the record as executed and delivered", async () => {
    const mint = (await launchBySymbol("MRDN")).baseMint;
    const { master, user, req } = await openVault(mint, 100n);
    const to = Keypair.generate().publicKey;
    const o = await signNow(mock, master, req(to, 40n));
    if (o.kind !== "stored") throw new Error(`unexpected ${o.kind}`);
    const w = o.record;
    expect((await recordVerdict(mock, conn, w)).kind).toBe("pending");
    await land(await phx.buildFundFeePayerTx(conn, user, feePayerKey(w), phx.FEE_PAYER_FUNDING_LAMPORTS));
    const plan = await planBroadcast(mock, conn, w, ledgers.vaultKeys);
    expect(plan).toMatchObject({ includesRelease: true, releaseError: null, searchNote: null, expectedAmount: 40n });
    await land(plan.tx);
    expect(await phx.getTokenBalance(conn, to, mint)).toBe(40n);
    expect(await recordVerdict(mock, conn, w)).toMatchObject({ kind: "executed", payout: null, ours: null });
    await expect(planBroadcast(mock, conn, w, ledgers.vaultKeys)).rejects.toThrow(/already executed/);
  });

  it("falls back to the withdrawal alone when the release would fail; the payout then waits, ours", async () => {
    const mint = dUsd();
    const { master, user, req } = await openVault(mint, 100n);
    const to = demoUser();
    state().frozen[`${to.toBase58()}:${mint.toBase58()}`] = true;
    const o = await signNow(mock, master, req(to, 60n));
    if (o.kind !== "stored") throw new Error(`unexpected ${o.kind}`);
    await land(await phx.buildFundFeePayerTx(conn, user, feePayerKey(o.record), phx.FEE_PAYER_FUNDING_LAMPORTS));
    const plan = await planBroadcast(mock, conn, o.record, ledgers.vaultKeys);
    expect(plan.includesRelease).toBe(false);
    expect(plan.releaseError).toMatch(/frozen/);
    expect(toHex(phx.decodeV1Transaction(plan.tx).instructions[0]?.data ?? new Uint8Array())).toContain(o.record.signature);
    await land(plan.tx);
    const verdict = await recordVerdict(mock, conn, o.record);
    expect(verdict.kind).toBe("executed");
    if (verdict.kind === "executed") {
      expect(verdict.ours).toBe(true);
      expect(verdict.payout?.amount).toBe(60n);
    }
  });

  it("an older version's record is added to the key ledger before its signature is simulated", async () => {
    const mint = (await launchBySymbol("MRDN")).baseMint;
    const { master, vault, user } = await openVault(mint, 100n);
    const old = recordBy({ vault, mint, key: phx.deriveVaultKey(master, "devnet", mint, 0, 0), next: phx.deriveVaultKey(master, "devnet", mint, 0, 1), to: Keypair.generate().publicKey, max: 7n });
    saveNewWithdrawal(old);
    // The SDK's builder refuses a signature the ledger does not hold (a simulation reveals it).
    await expect(mock.buildWithdrawTxWithFallback(conn, Keypair.generate(), withdrawArgsOf(old), { ledger: ledgers.vaultKeys })).rejects.toThrow(/does not hold this signature/);
    await land(await phx.buildFundFeePayerTx(conn, user, feePayerKey(old), phx.FEE_PAYER_FUNDING_LAMPORTS));
    const plan = await planBroadcast(mock, conn, old, ledgers.vaultKeys);
    expect(plan.simulation.ok).toBe(true);
    expect(await ledgers.vaultKeys.get(keyIdAt(master, mint, 0))).toMatchObject({ signature: old.signature });
  });

  it("refuses to reveal a second signature; the public one is re-broadcast even though the ledger holds another", async () => {
    const bastion = await launchBySymbol("BSTN");
    const mint = bastion.baseMint;
    const { master, vault, user } = await openVault(mint, 5_000n);
    // Another device signed (and broadcast, failing) a withdrawal to someone else at sequence 0.
    const k0 = phx.deriveVaultKey(master, "devnet", mint, 0, 0);
    const k1 = phx.deriveVaultKey(master, "devnet", mint, 0, 1);
    const elsewhere = Keypair.generate().publicKey;
    const theirsRecord = recordBy({ vault, mint, key: k0, next: k1, to: elsewhere, max: 7n });
    const feePayer = Keypair.generate();
    await land(await phx.buildFundFeePayerTx(conn, user, feePayer.publicKey, phx.FEE_PAYER_FUNDING_LAMPORTS));
    const theirs = await phx.buildWithdrawTx(conn, feePayer, { ...withdrawArgsOf(theirsRecord), includeRelease: true });
    await expect(phx.sendAndConfirm(conn, theirs.tx)).rejects.toThrow(/TransfersLocked/);

    // This browser signed (never revealed) its own withdrawal at the same sequence, through its ledger.
    const mine = recordBy({ vault, mint, key: k0, next: k1, to: user, max: 9n });
    saveNewWithdrawal(mine);
    await ledgers.vaultKeys.reserve(k0.keyId, hex(mine.message), { vault, sequence: 0n, key: k0.pk });
    await ledgers.vaultKeys.recordSignature(k0.keyId, hex(mine.message), hex(mine.signature), k1.pk);
    const err = await planBroadcast(mock, conn, mine, ledgers.vaultKeys).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevealedConflictError);
    const revealed = (err as RevealedConflictError).revealed;
    expect(revealed.destinationOwner.equals(elsewhere)).toBe(true);
    // Switching to the public withdrawal: its signature is already public, so it is broadcast although the ledger holds the other.
    const switched = recordFromRevealed(mock, { cluster: "devnet", mint, account: 0, vault }, k0.pk, revealed, feePayer);
    const plan = await planBroadcast(mock, conn, switched, ledgers.vaultKeys);
    expect(toHex(phx.decodeV1Transaction(plan.tx).instructions[0]?.data ?? new Uint8Array())).toContain(theirsRecord.signature);
    // A local signature that is neither in the ledger nor public is never broadcast.
    const third = recordBy({ vault, mint, key: k0, next: k1, to: demoUser(), max: 1n });
    const fresh = phx.createMemoryVaultKeyLedger();
    await fresh.reserve(k0.keyId, hex(mine.message), { vault, sequence: 0n, key: k0.pk });
    await fresh.recordSignature(k0.keyId, hex(mine.message), hex(mine.signature), k1.pk);
    await expect(planBroadcast({ ...mock, findPendingWithdrawal: async (c, v) => ({ ...(await mock.findPendingWithdrawal(c, v)), all: [] }) }, conn, third, fresh)).rejects.toThrow(
      /key records hold a different withdrawal of this key/,
    );
  });

  it("reports a record whose sequence was used by another withdrawal", async () => {
    const mint = dUsd();
    const { master, vault, user, req } = await openVault(mint, 100n);
    const to = demoUser();
    state().frozen[`${to.toBase58()}:${mint.toBase58()}`] = true;
    const o = await signNow(mock, master, req(to, 10n));
    if (o.kind !== "stored") throw new Error(`unexpected ${o.kind}`);
    // Another withdrawal (another recipient, another device) executes at sequence 0 first.
    const k0 = phx.deriveVaultKey(master, "devnet", mint, 0, 0);
    const k1 = phx.deriveVaultKey(master, "devnet", mint, 0, 1);
    const other = recordBy({ vault, mint, key: k0, next: k1, to: demoUser(), max: 5n });
    const feePayer = Keypair.generate();
    await land(await phx.buildFundFeePayerTx(conn, user, feePayer.publicKey, phx.FEE_PAYER_FUNDING_LAMPORTS));
    await land((await phx.buildWithdrawTx(conn, feePayer, withdrawArgsOf(other))).tx);
    const verdict = await recordVerdict(mock, conn, o.record);
    expect(verdict).toMatchObject({ kind: "executed", ours: false });
    expect(cannotExecute(verdict)).toBe(true);
  });
});

/** The throwaway fee payer of a record. */
function feePayerKey(w: StoredWithdrawal): PublicKey {
  return Keypair.fromSecretKey(hex(w.feePayerSecret)).publicKey;
}

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

async function launchBySymbol(symbol: string): Promise<T.LaunchAccount> {
  const l = (await phx.listLaunches(conn)).find((x) => x.market?.symbol === symbol);
  if (!l) throw new Error(`fixture ${symbol} missing`);
  return l;
}

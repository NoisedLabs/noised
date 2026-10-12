/**
 * MOCK chain state. Everything under src/lib/mock is a stand-in for Solana,
 * compiled only into builds made with VITE_NOISED_MOCK=1.
 *
 * The state lives in memory and is mirrored to localStorage so a demo
 * survives a reload. It is never sent anywhere.
 */
import type { AttestationAccount, CertificateAccount, CommitAccount, LaunchState, LmotsPublicKey, ShieldAccount } from "@noisedlabs/sdk";
import { PublicKey } from "@solana/web3.js";

import { fromHex, toHex } from "./bytes";

/** The name, symbol and uri `launch` wrote into the mint's TokenMetadata (from the attested record; the uri derived from it). */
export interface MockMintMetadata {
  name: string;
  symbol: string;
  uri: string;
}

export interface MockLaunch {
  /** The Launch PDA. */
  address: PublicKey;
  state: LaunchState;
  /** The mint's metadata once launched; null while configured. */
  meta: MockMintMetadata | null;
  initialSupply: bigint;
  /** Real quote (lamports) and base (base units) in the DBC pool. */
  quoteReserve: bigint;
  baseReserve: bigint;
  /** Virtual quote added in the constant-product price model. */
  virtualQuote: bigint;
  /** DBC trading fee (floor base fee) in bps. */
  feeBps: number;
  curveComplete: boolean;
  completedAt: number | null;
  migrated: boolean;
  dammPool: PublicKey | null;
  /** NFT mint of the launch authority's permanently locked DAMM v2 position. */
  positionNftMint: PublicKey | null;
  /** Fee tier chosen at launch, and the fee the DAMM v2 pool charges now (operators can raise it). */
  dammTierBps: number;
  dammFeeBps: number;
  dammStatus: "enabled" | "disabled";
  /** A keeper executes the batch a few seconds after the commit window closes. */
  keeper: boolean;
  /** Partner trading fees (wSOL) still in DBC, claimable by `claim_fees`. */
  feesClaimable: bigint;
  /** DAMM v2 position fees claimable by `claim_lp_fees` (wSOL and base tokens). */
  lpFeesQuote: bigint;
  lpFeesBase: bigint;
  /** Held by the launch authority until `distribute` (wSOL routed, base burned). */
  authorityQuote: bigint;
  authorityBase: bigint;
  certificate: CertificateAccount | null;
  /** Hook policy caps, in base units (0 = off). */
  maxWallet: bigint;
  maxBuy: bigint;
  baseVault: PublicKey | null;
  /** DBC `has_swap`: set by the pool's first swap; `execute_batch` requires it unset (`PoolAlreadyTraded`). */
  hasSwap: boolean;
}

/** A vault v4: fixed address, key rotated in place at every withdrawal. */
export interface MockVault {
  address: PublicKey;
  bump: number;
  mint: PublicKey;
  /** Key id of the key that opened the vault (the PDA seed). */
  genesisKeyId: Uint8Array;
  /** Withdrawals executed so far; the next withdrawal signs this value. */
  sequence: bigint;
  keyId: Uint8Array;
  key: LmotsPublicKey;
  /** Tokens held for payouts not yet released. */
  reserved: bigint;
}

/** Tokens a withdrawal reserved, waiting for `release` / `release_to` (closed when delivered). */
export interface MockPayout {
  address: PublicKey;
  bump: number;
  vault: PublicKey;
  sequence: bigint;
  destinationOwner: PublicKey;
  amount: bigint;
  rentPayer: PublicKey;
}

/** One landed `withdraw` (succeeded or failed): its signature is public either way. */
export interface MockWithdrawAttempt {
  txSignature: string;
  failed: boolean;
  slot: number;
  destinationOwner: PublicKey;
  maxAmount: bigint;
  nextKeyId: Uint8Array;
  nextKey: LmotsPublicKey;
  signature: Uint8Array;
}

/** A PQ identity's account: its LMS public key and its leaf bitmap (`used`, 128 bytes: bit q is set once leaf q landed). */
export interface MockIdentity {
  publicKey: Uint8Array;
  used: Uint8Array;
}

export interface MockShield {
  account: ShieldAccount;
  zSupply: bigint;
}

export interface MockState {
  version: 7;
  seededAt: number;
  slot: number;
  launches: Record<string, MockLaunch>;
  commits: Record<string, CommitAccount>;
  /** `["attestation", launch]` by launch (PQ v2: `launch` refuses without an attested one, and only inside its window). */
  attestations: Record<string, AttestationAccount>;
  /** TokenMeta records (`["metadata", launch, metadata_hash]`) by address: the exact account bytes (`tokenMetaAccountData`). Never modified or closed. */
  tokenMetas: Record<string, Uint8Array>;
  /** PQ identities (`["identity", identity id]`) by address: created by the identity's first `attest_launch`. */
  identities: Record<string, MockIdentity>;
  /** `PayoutVault.committed` by `${launch}:${vault}`: everything committed with that PQ vault as token owner (held to the per-wallet cap). */
  payoutVaults: Record<string, bigint>;
  /** Lamports by owner. */
  sol: Record<string, bigint>;
  /** Token balances by `${owner}:${mint}` (the owner's canonical token account). */
  tokens: Record<string, bigint>;
  vaults: Record<string, MockVault>;
  /** By payout PDA. */
  payouts: Record<string, MockPayout>;
  /** `withdraw` attempts that landed, by vault, oldest first (the history `findPendingWithdrawal` reads). */
  vaultHistory: Record<string, MockWithdrawAttempt[]>;
  /** Token accounts frozen by their mint's freeze authority, by `${owner}:${mint}`. */
  frozen: Record<string, true>;
  /** By base mint. */
  shields: Record<string, MockShield>;
  /** Fingerprints of landed transactions (duplicate detection). */
  landed: Record<string, number>;
  /** Owners that already received demo balances. */
  funded: Record<string, true>;
}

const STORAGE_KEY = "noised.demo-chain.v7";
/**
 * Demo state of earlier protocol versions: discarded (vault v3 layouts; launches without a PQ identity, attestation or
 * payout owners; v4: attestations of the name, symbol and uri instead of an on-chain metadata record; v5: no identity
 * accounts, so no leaf bitmap for the app's own attestations, and demo records without a document; v6: certificates
 * that did not record the demo's signed launch rules, RULES_BOUND, and freeze approvals without an expiry).
 */
const OLD_STORAGE_KEYS = ["noised.demo-chain.v2", "noised.demo-chain.v3", "noised.demo-chain.v4", "noised.demo-chain.v5", "noised.demo-chain.v6"];

export function serialize(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    const raw = this[key];
    if (raw instanceof PublicKey) return { $pk: raw.toBase58() };
    if (typeof raw === "bigint") return { $big: raw.toString() };
    if (raw instanceof Uint8Array) return { $u8: toHex(raw) };
    return v;
  });
}

export function deserialize<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1) {
        if (typeof o.$pk === "string") return new PublicKey(o.$pk);
        if (typeof o.$big === "string") return BigInt(o.$big);
        if (typeof o.$u8 === "string") return fromHex(o.$u8);
      }
    }
    return v;
  }) as T;
}

function readStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(text: string | null): void {
  try {
    if (text === null) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, text);
  } catch {
    // Storage blocked or full: the demo still works in memory.
  }
}

let current: MockState | null = null;
let seedFn: (() => MockState) | null = null;

/** Fired after every state change so open pages can refresh. */
export const mockEvents = new EventTarget();

export function installSeed(seed: () => MockState): void {
  seedFn = seed;
}

export function state(): MockState {
  if (current) return current;
  for (const old of OLD_STORAGE_KEYS) {
    try {
      globalThis.localStorage?.removeItem(old);
    } catch {
      // Storage blocked: nothing to clean up.
    }
  }
  const text = readStorage();
  if (text !== null) {
    try {
      const parsed = deserialize<MockState>(text);
      if (parsed.version === 7 && typeof parsed.seededAt === "number") {
        current = parsed;
        return current;
      }
    } catch {
      // Corrupt demo state: re-seed below.
    }
  }
  if (!seedFn) throw new Error("mock seed not installed");
  current = seedFn();
  persist();
  return current;
}

export function persist(): void {
  if (!current) return;
  writeStorage(serialize(current));
  mockEvents.dispatchEvent(new Event("change"));
}

export function resetState(): void {
  if (!seedFn) throw new Error("mock seed not installed");
  current = seedFn();
  persist();
}

/** Only for tests: start from a fresh seed without touching storage. */
export function replaceStateForTests(next: MockState): void {
  current = next;
}

export const nowSecs = (): number => Math.floor(Date.now() / 1000);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulated network latency (shorter under test). */
export function latency(kind: "read" | "build" | "simulate" | "send"): Promise<void> {
  if (import.meta.env.MODE === "test") return Promise.resolve();
  const range = { read: [120, 380], build: [80, 220], simulate: [250, 650], send: [700, 1500] }[kind];
  const [lo, hi] = range as [number, number];
  return sleep(lo + Math.random() * (hi - lo));
}

export const tokenKey = (owner: PublicKey, mint: PublicKey): string => `${owner.toBase58()}:${mint.toBase58()}`;
export const commitKey = (launch: PublicKey, owner: PublicKey): string => `${launch.toBase58()}:${owner.toBase58()}`;
export const payoutVaultKey = (launch: PublicKey, vault: PublicKey): string => `${launch.toBase58()}:${vault.toBase58()}`;

export function tokenBalance(s: MockState, owner: PublicKey, mint: PublicKey): bigint {
  return s.tokens[tokenKey(owner, mint)] ?? 0n;
}

/** Whether `owner`'s canonical token account for `mint` exists (created by its first credit, even of 0; closing removes it). */
export function tokenAccountExists(s: MockState, owner: PublicKey, mint: PublicKey): boolean {
  return s.tokens[tokenKey(owner, mint)] !== undefined;
}

export function addTokens(s: MockState, owner: PublicKey, mint: PublicKey, delta: bigint): void {
  const k = tokenKey(owner, mint);
  const next = (s.tokens[k] ?? 0n) + delta;
  if (next < 0n) throw new Error("mock token balance underflow");
  s.tokens[k] = next;
}

export function solBalance(s: MockState, owner: PublicKey): bigint {
  return s.sol[owner.toBase58()] ?? 0n;
}

export function addSol(s: MockState, owner: PublicKey, delta: bigint): void {
  const k = owner.toBase58();
  const next = (s.sol[k] ?? 0n) + delta;
  if (next < 0n) throw new Error("mock SOL balance underflow");
  s.sol[k] = next;
}

export const isFrozen = (s: MockState, owner: PublicKey, mint: PublicKey): boolean => s.frozen[tokenKey(owner, mint)] === true;

export function launchByMint(s: MockState, mint: PublicKey): MockLaunch | null {
  for (const l of Object.values(s.launches)) if (l.state.status === "live" && l.state.baseMint.equals(mint)) return l;
  return null;
}

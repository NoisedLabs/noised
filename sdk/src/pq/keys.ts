/**
 * PQ recovery phrase and LM-OTS key derivation (SPEC §3.10, vault v4).
 *
 * The PQ recovery phrase is a separate 24-word BIP-39 phrase. It is never
 * derived from an Ed25519 wallet: a quantum attacker who recovers a wallet's
 * private key from its address would otherwise also hold every PQ key.
 *
 * A phrase holds several vaults per (cluster, mint), numbered by `account`.
 * A vault's address never moves; its key rotates in place, and the key that
 * signs the withdrawal at `sequence` is derived from `(account, sequence)`.
 * The genesis key (the one that opens the vault and fixes its address) is
 * `sequence = 0`. `(account, sequence)` never repeats, so keys never repeat.
 *
 *   master = BIP-39 seed of the phrase (64 bytes, empty passphrase)
 *   path   = cluster (1 byte: 0 mainnet, 1 devnet, 2 localnet) | mint (32)
 *            | u32le(account) | u32le(sequence)                 (41 bytes)
 *   SEED   = SHA256("phalanx/pq/lmots/seed" | master | path)
 *   I      = SHA256("phalanx/pq/lmots/id"   | master | path)[..16]
 *   q      = sequence
 *
 * `q = sequence` is enforced on chain (vault key-index binding):
 * `open_vault` accepts only `q = 0`, and `withdraw` at `sequence` accepts
 * only a next key with `q = sequence + 1` (InvalidKeyIndex, 6006). So every
 * key of a vault sits at its own position and no key can ever control a
 * vault twice. The SDK derives keys only this way and refuses to sign a
 * withdrawal whose keys break the rule (it could never execute).
 *
 * v3 paths were 37 bytes (no account number), so no v4 key equals a v3 key.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { PublicKey } from "@solana/web3.js";

import { concatBytes, isAllZero, isUint, toHex, U32_MAX, u32le, utf8 } from "../codec/bytes.js";
import { CLUSTERS, type Cluster } from "../constants.js";
import type { VaultKeyMaterial } from "../types.js";
import * as lmots from "./lmots.js";

export const RECOVERY_PHRASE_WORDS = 24;

/** SHA-256 of the concatenation, wiping the concatenated copy (it holds the master; audit 4, ID-F7). */
function hashWiped(parts: readonly Uint8Array[]): Uint8Array {
  const buf = concatBytes(parts);
  try {
    return sha256(buf);
  } finally {
    buf.fill(0);
  }
}
// protocol constant: kept from the original name; changing it changes every key derived from a phrase or passkey
const SEED_DOMAIN = utf8("phalanx/pq/lmots/seed");
const ID_DOMAIN = utf8("phalanx/pq/lmots/id");
const WORDS = new Set(wordlist);

/** A fresh 24-word phrase (256 bits from the platform CSPRNG). */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

/** NFKD, lower case, single spaces: the form BIP-39 hashes. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .join(" ");
}

export function isBip39Word(word: string): boolean {
  return WORDS.has(word.normalize("NFKD").trim().toLowerCase());
}

/** Problems with a typed phrase, in plain words (empty = valid). Never echoes the phrase. */
export function phraseProblems(phrase: string): string[] {
  const words = normalizePhrase(phrase)
    .split(" ")
    .filter((w) => w !== "");
  if (words.length !== RECOVERY_PHRASE_WORDS) return [`The phrase must have ${RECOVERY_PHRASE_WORDS} words (it has ${words.length}).`];
  const unknown = words.map((w, i) => (WORDS.has(w) ? -1 : i + 1)).filter((i) => i > 0);
  if (unknown.length > 0) return [`Word ${unknown.join(", ")} is not in the BIP-39 English word list.`];
  if (!validateMnemonic(words.join(" "), wordlist)) return ["The checksum does not match: a word is wrong or out of order."];
  return [];
}

/**
 * Refuses anything but a 64-byte seed that is not all zero. An all-zero
 * "master" is no phrase's seed (it is what a wiped buffer looks like), and
 * every key derived from it is public: a withdrawal naming such a key as the
 * next key hands the vault to anyone. (Used by the vault module; not part of
 * the package's API.)
 */
export function checkMaster(master: Uint8Array): void {
  if (!(master instanceof Uint8Array) || master.length !== 64) throw new RangeError("master must be the 64-byte BIP-39 seed");
  if (isAllZero(master)) {
    throw new RangeError("refusing an all-zero master seed: it is not the seed of any phrase (was it wiped?), and every key derived from it is public");
  }
}

/** BIP-39 seed (64 bytes) of a valid 24-word phrase; throws otherwise (never returns an all-zero seed). */
export function masterFromPhrase(phrase: string): Uint8Array {
  const problems = phraseProblems(phrase);
  if (problems.length > 0) throw new Error(problems[0]);
  const master = mnemonicToSeedSync(normalizePhrase(phrase));
  checkMaster(master);
  return master;
}

/** `cluster (1) | mint (32) | u32le(account) | u32le(sequence)` (41 bytes). */
export function derivationPath(cluster: Cluster, mint: PublicKey, account: number, sequence: number): Uint8Array {
  const c = CLUSTERS[cluster];
  if (c === undefined) throw new RangeError(`unknown cluster ${String(cluster)}`);
  if (!isUint(account, U32_MAX)) throw new RangeError("vault account number must be a u32");
  if (!isUint(sequence, U32_MAX)) throw new RangeError("key sequence must be a u32 (a vault cannot rotate past 2^32 - 1)");
  return concatBytes([Uint8Array.of(c.id), mint.toBytes(), u32le(account), u32le(sequence)]);
}

/**
 * The LM-OTS key of vault `account` for `mint` on `cluster` at `sequence`
 * (SPEC §3.10): the genesis key is `sequence = 0`, the key that signs the
 * withdrawal at the vault's `sequence` is that sequence, and the next key is
 * `sequence + 1`. `q = sequence`. Refuses an all-zero `master` (a wiped
 * buffer): its keys are public.
 */
export function deriveVaultKey(master: Uint8Array, cluster: Cluster, mint: PublicKey, account: number, sequence: number): VaultKeyMaterial {
  checkMaster(master);
  const path = derivationPath(cluster, mint, account, sequence);
  const skSeed = hashWiped([SEED_DOMAIN, master, path]);
  const id = hashWiped([ID_DOMAIN, master, path]).slice(0, lmots.ID_LEN);
  const pk = lmots.publicKey({ id, q: sequence, seed: skSeed });
  return { skSeed, pk, keyId: lmots.keyId(pk) };
}

/**
 * LM-OTS index `q` of a vault's genesis key (`state::GENESIS_KEY_INDEX`):
 * `open_vault` refuses any other (InvalidKeyIndex, 6006). It is the key of
 * `deriveVaultKey(..., account, 0)`.
 */
export const GENESIS_KEY_INDEX = 0;

/**
 * The LM-OTS index `q` that the next key named by the withdrawal at
 * `sequence` must have (`state::next_key_index`): `sequence + 1`, or null
 * when that does not fit a u32 (a vault cannot withdraw at sequence
 * 2^32 - 1). `withdraw` refuses any other index (InvalidKeyIndex, 6006), and
 * the signed next key id commits to the index, so a signature naming a key
 * of another position could never execute. `deriveVaultKey(..., account,
 * sequence + 1)` is exactly that key.
 */
export function nextKeyIndex(sequence: bigint): number | null {
  if (typeof sequence !== "bigint" || sequence < 0n) throw new RangeError("sequence must be a non-negative bigint");
  const next = sequence + 1n;
  return next > BigInt(U32_MAX) ? null : Number(next);
}

/** `sequence` as the `number` key derivation takes; throws past u32 (no key exists there). */
export function keySequence(sequence: bigint): number {
  if (typeof sequence !== "bigint" || sequence < 0n || sequence > BigInt(U32_MAX)) {
    throw new RangeError(`vault sequence ${String(sequence)} has no key: keys exist for sequences 0..=${U32_MAX}`);
  }
  return Number(sequence);
}

// kept from the original name ("phalanx/pq/fingerprint"): changing it changes every fingerprint users already compare
/** Short, non-secret fingerprint of a master seed so users can tell phrases apart. */
export function masterFingerprint(master: Uint8Array): string {
  if (master.length !== 64) throw new RangeError("master must be the 64-byte BIP-39 seed");
  return toHex(hashWiped([utf8("phalanx/pq/fingerprint"), master]).slice(0, 4)).toUpperCase();
}

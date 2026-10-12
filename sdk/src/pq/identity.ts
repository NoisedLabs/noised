/**
 * Post-quantum creator identity (PQ v2, amendments A4, A5, A12, A13, A16):
 * where an identity's LMS key comes from, how it is named on-chain, which
 * leaf signs which message, and the exact bytes it signs.
 *
 * # Where the secret comes from (A12)
 *
 * Never from the wallet: an Ed25519 signature is deterministic, so whoever
 * recovers the wallet key (a quantum computer, from the address) recomputes
 * anything derived from it. The root secret is the 32-byte BIP-39 entropy
 * of a 24-word PQ recovery phrase:
 *
 * - phrase: the user's 24 words (`importMaster`, the vault's phrase);
 * - passkey: the WebAuthn PRF (CTAP2 hmac-secret) output of a passkey,
 *   `entropy = HKDF-SHA256(IKM = PRF output, salt = "phalanx/pq/passkey/v1",
 *   info = "phalanx/pq/passkey/v1/bip39-entropy", L = 32)`, evaluated with
 *   `prf.eval.first = UTF-8 "phalanx/pq/passkey/v1/prf-salt"` and user
 *   verification required (`deriveMasterFromPasskeyPrf`).
 *
 * Both give `master = BIP-39 seed(mnemonic(entropy), "")` (64 bytes). A
 * 64-byte seed cannot be turned back into words (PBKDF2 is one-way), which is
 * why the passkey path stops at the entropy: `exportMasterAsPhrase` writes
 * the 24 words of that entropy, and `importMaster` of those words reproduces
 * the master, hence every identity, byte for byte.
 *
 * ```text
 * path = cluster (0 mainnet, 1 devnet, 2 localnet) || u32le(identity index)        5 bytes
 * SEED = SHA256("phalanx/pq/identity/v1/seed" || master || path)
 * I    = SHA256("phalanx/pq/identity/v1/id"   || master || path)[..16]
 * pk   = u32be(6) || u32be(3) || I || T[1]     identityId = SHA256(0x21 || pk)
 * ```
 *
 * The cluster byte keeps each cluster's leaves apart: the program cannot see
 * which cluster it runs on, and one key on two clusters would have two
 * bitmaps, so a leaf could be used once on each (two signatures = forgeries).
 * Check the cluster against the RPC's genesis hash before deriving.
 *
 * Passkey trust (A12 and the review): the PRF secret lives in the
 * authenticator; it is an HMAC, not a public-key computation. But it travels
 * under classical (P-256) channels to roaming authenticators and through the
 * hybrid (QR) transport, and synced passkeys move it through the provider's
 * end-to-end sync. Prefer platform authenticators or directly attached keys,
 * always require user verification (hmac-secret returns a different secret
 * without it), export the 24 words as the backup, and feature-detect PRF
 * (fall back to the phrase). The RP ID is the exact app host: never an IP
 * address (WebAuthn refuses them; use `localhost` in development), never a
 * shared parent domain.
 *
 * # Leaves (A13 with the review's fix)
 *
 * Each leaf signs exactly one message, ever (`./lms.ts`). The identity
 * account's bitmap marks leaves whose signatures LANDED; durable local
 * records (`./leafLedger.ts`) mark the leaves whose signatures may have been
 * revealed. A message's leaf is the first leaf, from the SECRET probe start
 * `u16be(HMAC-SHA256(probeKey, "phalanx/pq/identity/leaf/v2" || message)[0..2]) mod 1024`
 * (`probeKey = HMAC-SHA256(SEED, "phalanx/pq/identity/leaf/v2/key" || I)`;
 * audit 4, ID-F1a) stepping +1 with wrap-around, that is absent from the
 * records and from this process's signatures: the same message gives the
 * same leaf and the same bytes, so a retry is idempotent. The on-chain
 * bitmap never moves the choice (an RPC could fake it to steer the probe):
 * if the chosen leaf is set on-chain, or the bitmap shows any used leaf the
 * records do not know, nothing new is signed (`UnknownLeavesError`) until
 * the other device's records are imported (`importLeafRecords`) or the user
 * acknowledges them (`acknowledgeUnknownLeaves`). Keep ONE ledger per
 * identity, or sync records between devices. Warn at 1,000 used leaves; at
 * 1,024 move to the next identity index.
 *
 * # What is signed (A4, A5, the fix stage and on-chain metadata)
 *
 * ```text
 * "PHX-ATTEST-V3" (13) || launchpad program id || launch || params_hash || creator
 *     || metadata_hash || rules_hash || i64le(not_before) || i64le(not_after)          221 bytes
 * metadata_hash = SHA256("PHX-META-V2" || u32le(len) name || u32le(len) symbol || u8 flags
 *                        || u32le(len) uri || u32le(len) doc)       (`metadataHashV2`)
 * rules_hash    = SHA256("PHX-RULES-V1" || PXR1 bytes), or 32 zero bytes for no rules
 * "PHX-AUTH-V1" (11) || launchpad program id || launch || creator || u8 kind
 *     || payload_hash                                                                   140 bytes
 * ```
 *
 * The creator rules are an on-chain record too (`LaunchRules`, at
 * `["rules", launch, rules_hash]`, `publish_rules`): `attest_launch`
 * attests only rules that exist, and `launch` installs exactly those bytes
 * in the hook policy. The same identity signs authorizations
 * (`pq_authorize`: the autopilot's graph activations, freezes and operator
 * revocations), with the same one-time-leaf bitmap.
 *
 * The metadata is an on-chain record (`TokenMeta`, `../metadata/record.ts`)
 * at `["metadata", launch, metadata_hash]`, so the signature covers every
 * byte a reader displays. `attest_launch` verifies the signature first and
 * burns its leaf whenever it verifies; it records an attestation only if
 * the key is the launch's `pq_identity`, the record its hash names exists
 * (`publish_metadata` validated it), the window can still be used
 * (60..=3,600 s long, at least 60 s of it left when it lands, opening at
 * most 604,800 s after it lands; unix SECONDS) and the launch's attestation
 * slot is free (none yet, or one whose window passed unused while the
 * launch is still `Configured`: audit round 3 F1). Anything else lands
 * burn-only: publish the records and wait until they are final BEFORE
 * signing (`validateTokenMeta`, `validateLaunchWindow`), and after landing
 * check that the attestation account has version 3 and this message's hash
 * (`attestationAttestsMessage`) rather than assume it attested. Sign only a
 * finalized launch this wallet created. Version 1 (name, symbol, uri and a
 * document hash) and the 189-byte version 2 (no rules hash) are retired.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { PublicKey } from "@solana/web3.js";

import { bytesEqual, concatBytes, I64_MAX, I64_MIN, isAllZero, isUint, toHex, U32_MAX, u32le, utf8 } from "../codec/bytes.js";
import { AUTHORIZATION, CLUSTERS, PQ_IDENTITY, PROGRAM_IDS, type Cluster } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { identityAddressFromId } from "../pda.js";
import type { AttestationAccount } from "../types.js";
import { checkMaster, masterFromPhrase, normalizePhrase } from "./keys.js";
import { identityId, LMS_LEAVES, LmsKeyPair, lmsKeyPair, type LmsKeyPairOptions, type LmsPrivateKey } from "./lms.js";

export { identityId } from "./lms.js";

function checkBytes(name: string, b: unknown, len: number): asserts b is Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (b.length !== len) throw new RangeError(`${name} must be ${len} bytes, got ${b.length}`);
}

/** SHA-256 of the concatenation, wiping the concatenated copy (it holds secrets). */
function hashWiped(parts: readonly Uint8Array[]): Uint8Array {
  const buf = concatBytes(parts);
  try {
    return sha256(buf);
  } finally {
    buf.fill(0);
  }
}

// ------------------------------------------------------------ derivation ---

/** Domain tag of an identity's `SEED` (`noised_lmots::lms::IDENTITY_SEED_TAG`). */
export const IDENTITY_SEED_TAG = PQ_IDENTITY.IDENTITY_SEED_TAG;
/** Domain tag of an identity's `I` (`noised_lmots::lms::IDENTITY_ID_TAG`). */
export const IDENTITY_ID_TAG = PQ_IDENTITY.IDENTITY_ID_TAG;
/** Largest cluster byte of the derivation (0 mainnet, 1 devnet, 2 localnet). */
export const MAX_IDENTITY_CLUSTER = 2;

const SEED_TAG = utf8(IDENTITY_SEED_TAG);
const ID_TAG = utf8(IDENTITY_ID_TAG);

/** `cluster (1) || u32le(index)` (5 bytes). */
export function identityPath(cluster: Cluster, index: number): Uint8Array {
  const c = CLUSTERS[cluster];
  if (c === undefined || c.id > MAX_IDENTITY_CLUSTER) throw new RangeError(`unknown cluster ${String(cluster)}`);
  if (!isUint(index, U32_MAX)) throw new RangeError("identity index must be a u32");
  return concatBytes([Uint8Array.of(c.id), u32le(index)]);
}

/**
 * The LMS private key of identity `index` of `master` (the phrase's 64-byte
 * BIP-39 seed) on `cluster`, exactly as `noised_lmots::LmsPrivateKey::
 * derive_identity`. Refuses an all-zero master (a wiped buffer: every key
 * from it is public).
 */
export function deriveIdentityKey(master: Uint8Array, cluster: Cluster, index: number): LmsPrivateKey {
  checkMaster(master);
  const path = identityPath(cluster, index);
  const seed = hashWiped([SEED_TAG, master, path]);
  const id = hashWiped([ID_TAG, master, path]).slice(0, 16);
  return { seed, id };
}

/** A derived creator identity: its key pair (tree included), public key, identity id and account. */
export interface PqIdentity {
  readonly cluster: Cluster;
  readonly index: number;
  readonly keyPair: LmsKeyPair;
  /** 56-byte LMS public key. */
  readonly publicKey: Uint8Array;
  /** `SHA256(0x21 || publicKey)`: the launch's `pq_identity`. */
  readonly identityId: Uint8Array;
  /** `["identity", identityId]` under the launchpad. */
  readonly address: PublicKey;
}

/**
 * Identity `index` of `master` on `cluster`, with its tree: from
 * `opts.cache` when it holds a valid one (milliseconds), else by a
 * non-blocking key generation with `opts.onProgress` (see `lmsKeygen`).
 * `opts.expectedPublicKey` (e.g. from the launch's identity account)
 * refuses any other key.
 */
export async function deriveIdentity(master: Uint8Array, cluster: Cluster, index: number, opts: LmsKeyPairOptions = {}): Promise<PqIdentity> {
  const sk = deriveIdentityKey(master, cluster, index);
  try {
    const keyPair = await lmsKeyPair(sk, opts);
    const publicKey = keyPair.publicKey;
    const id = identityId(publicKey);
    return { cluster, index, keyPair, publicKey, identityId: id, address: identityAddressFromId(id) };
  } finally {
    sk.seed.fill(0);
  }
}

/** `deriveIdentity` from the 24 words (validated; the master is wiped after use). */
export async function deriveIdentityFromPhrase(phrase: string, cluster: Cluster, index: number, opts: LmsKeyPairOptions = {}): Promise<PqIdentity> {
  const master = masterFromPhrase(phrase);
  try {
    return await deriveIdentity(master, cluster, index, opts);
  } finally {
    master.fill(0);
  }
}

// --------------------------------------------- master secret and backup ---

/**
 * The PQ root secret: the 32-byte BIP-39 entropy that the 24 words encode,
 * and the 64-byte BIP-39 seed of those words (what every derivation takes).
 */
export interface PqMaster {
  readonly entropy: Uint8Array;
  readonly master: Uint8Array;
}

/** Bytes of BIP-39 entropy behind a 24-word phrase. */
export const PQ_ENTROPY_LEN = 32;

function checkEntropy(entropy: unknown): asserts entropy is Uint8Array {
  checkBytes("entropy", entropy, PQ_ENTROPY_LEN);
  if (isAllZero(entropy)) throw new RangeError("refusing all-zero entropy: it is not a secret (was it wiped?)");
}

/** The master of 24 words (validated as `masterFromPhrase` does: words, checksum, never an all-zero seed). */
export function importMaster(phrase: string): PqMaster {
  const master = masterFromPhrase(phrase);
  const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
  return { entropy, master };
}

/**
 * The 24 words that restore `secret` (its entropy), checked: the words are
 * turned back into a master and must give exactly `secret.master`, so a
 * backup can never restore another identity. A bare 64-byte seed is refused:
 * it cannot be turned back into words.
 */
export function exportMasterAsPhrase(secret: PqMaster): string {
  if (secret instanceof Uint8Array) {
    throw new TypeError("a 64-byte BIP-39 seed cannot be turned back into words (PBKDF2 is one-way): export the PqMaster that carries its entropy");
  }
  checkEntropy(secret.entropy);
  checkMaster(secret.master);
  const phrase = entropyToMnemonic(secret.entropy, wordlist);
  const again = masterFromPhrase(phrase);
  try {
    if (!bytesEqual(again, secret.master)) throw new Error("these words would restore a different master: refusing to export a backup that does not reproduce this identity");
  } finally {
    again.fill(0);
  }
  return phrase;
}

/** Overwrite both secrets (best effort: phrase strings cannot be wiped in JavaScript). */
export function wipeMaster(secret: PqMaster): void {
  secret.entropy.fill(0);
  secret.master.fill(0);
}

// ---------------------------------------------------------------- passkey ---

// protocol constants (PRF salt, HKDF salt and info): kept from the original name; changing them changes every passkey-derived key
/** UTF-8 of the WebAuthn PRF input (`prf.eval.first`). The browser hashes it with the "WebAuthn PRF" context before the authenticator sees it. */
export const PASSKEY_PRF_SALT = "phalanx/pq/passkey/v1/prf-salt";
/** HKDF-SHA256 salt of the passkey path. */
export const PASSKEY_HKDF_SALT = "phalanx/pq/passkey/v1";
/** HKDF-SHA256 info of the passkey path: the output is BIP-39 entropy. */
export const PASSKEY_HKDF_INFO = "phalanx/pq/passkey/v1/bip39-entropy";
/** Bytes of a PRF (hmac-secret) output. */
export const PASSKEY_PRF_OUTPUT_LEN = 32;
/** WebAuthn authenticator-data flags. */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/** `HKDF-SHA256(IKM = prfOutput, salt = PASSKEY_HKDF_SALT, info = PASSKEY_HKDF_INFO, L = 32)`: the 24 words' entropy. */
export function passkeyEntropy(prfOutput: Uint8Array): Uint8Array {
  checkBytes("PRF output", prfOutput, PASSKEY_PRF_OUTPUT_LEN);
  if (isAllZero(prfOutput)) throw new RangeError("refusing an all-zero PRF output: no authenticator returns it (a stub or a wiped buffer?)");
  return hkdf(sha256, prfOutput, utf8(PASSKEY_HKDF_SALT), utf8(PASSKEY_HKDF_INFO), PQ_ENTROPY_LEN);
}

/**
 * The PQ master of a passkey: `passkeyEntropy(prfOutput)`, its 24 words, and
 * their BIP-39 seed. `userVerified` must be true (read it from the
 * assertion's flags, or use `deriveMasterFromPasskeyAssertion`): hmac-secret
 * returns a different secret without user verification, which would derive
 * another identity. `exportMasterAsPhrase` of the result is the backup.
 */
export function deriveMasterFromPasskeyPrf(prfOutput: Uint8Array, opts: { readonly userVerified: boolean }): PqMaster {
  if (opts?.userVerified !== true) {
    throw new Error("the passkey's PRF output must come from a user-verified assertion: without user verification the authenticator returns a different secret");
  }
  const entropy = passkeyEntropy(prfOutput);
  const master = masterFromPhrase(entropyToMnemonic(entropy, wordlist));
  return { entropy, master };
}

/** Structural view of a WebAuthn assertion (`PublicKeyCredential` with an `AuthenticatorAssertionResponse`). */
export interface PasskeyAssertionLike {
  /** `response.authenticatorData`. */
  readonly authenticatorData: ArrayBuffer | ArrayBufferView;
  /** `getClientExtensionResults()`. */
  readonly clientExtensionResults: { readonly prf?: { readonly results?: { readonly first?: ArrayBuffer | ArrayBufferView } } };
}

function viewBytes(b: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  throw new TypeError("expected an ArrayBuffer or a typed array");
}

/**
 * The PRF output of an assertion made with `passkeyRequestOptions`, after
 * checking that it is for `rpId` (authenticator data's RP ID hash), that the
 * user was present and verified (flags UP and UV), and that the PRF result
 * is 32 bytes. Throws otherwise (fall back to the phrase when the
 * authenticator has no PRF).
 */
export function passkeyPrfFromAssertion(assertion: PasskeyAssertionLike, opts: { readonly rpId: string }): { prfOutput: Uint8Array; userVerified: true } {
  checkPasskeyRpId(opts.rpId);
  const authData = viewBytes(assertion.authenticatorData);
  if (authData.length < 37) throw new Error("authenticator data is too short");
  if (!bytesEqual(authData.subarray(0, 32), sha256(utf8(opts.rpId)))) throw new Error(`this assertion is not for the RP ID ${opts.rpId}`);
  const flags = authData[32]!;
  if ((flags & FLAG_UP) === 0) throw new Error("the authenticator did not report user presence");
  if ((flags & FLAG_UV) === 0) throw new Error("the authenticator did not verify the user (PIN or biometrics): its PRF output would be a different secret");
  const first = assertion.clientExtensionResults.prf?.results?.first;
  if (first === undefined) throw new Error("this passkey returned no PRF output: it does not support the PRF extension (use the 24-word phrase)");
  const prf = viewBytes(first);
  if (prf.length !== PASSKEY_PRF_OUTPUT_LEN) throw new Error(`the PRF output must be ${PASSKEY_PRF_OUTPUT_LEN} bytes, got ${prf.length}`);
  return { prfOutput: Uint8Array.from(prf), userVerified: true };
}

/** `deriveMasterFromPasskeyPrf(passkeyPrfFromAssertion(assertion, opts))`, wiping the PRF copy. */
export function deriveMasterFromPasskeyAssertion(assertion: PasskeyAssertionLike, opts: { readonly rpId: string }): PqMaster {
  const r = passkeyPrfFromAssertion(assertion, opts);
  try {
    return deriveMasterFromPasskeyPrf(r.prfOutput, { userVerified: r.userVerified });
  } finally {
    r.prfOutput.fill(0);
  }
}

/**
 * Throws unless `rpId` is a lower-case host name: no scheme, port, path or
 * trailing dot, and not an IP address (WebAuthn refuses them; develop on
 * `localhost`). It must be the exact app host, never a shared parent domain
 * (any site under it could request the same passkey).
 */
export function checkPasskeyRpId(rpId: string): void {
  if (typeof rpId !== "string" || rpId.length === 0 || rpId.length > 253) throw new RangeError("RP ID must be a host name of 1..253 characters");
  if (rpId !== rpId.toLowerCase()) throw new RangeError("RP ID must be lower case");
  if (/^[0-9.]+$/.test(rpId) || rpId.includes(":") || rpId.includes("[")) throw new RangeError("RP ID must be a domain name, not an IP address");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(rpId)) {
    throw new RangeError("RP ID must be a bare host name (no scheme, port, path or trailing dot)");
  }
}

/** Copy into a fresh `ArrayBuffer`-backed array (what WebAuthn's `BufferSource` accepts). */
function bufferBytes(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

function randomBuffer(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** `PublicKeyCredentialCreationOptions` (structurally) for a PQ passkey. */
export interface PasskeyCreationOptions {
  rp: { id: string; name: string };
  user: { id: Uint8Array<ArrayBuffer>; name: string; displayName: string };
  challenge: Uint8Array<ArrayBuffer>;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  authenticatorSelection: {
    residentKey: "required";
    requireResidentKey: true;
    userVerification: "required";
    authenticatorAttachment?: "platform" | "cross-platform";
  };
  /** WebAuthn L3 hints: prefer this device's authenticator, then a security key (not the hybrid QR transport). */
  hints: string[];
  attestation: "none";
  timeout: number;
  excludeCredentials: { type: "public-key"; id: Uint8Array<ArrayBuffer> }[];
  /** Ask the authenticator to enable PRF; check `getClientExtensionResults().prf.enabled` after creation. */
  extensions: { prf: Record<string, never> };
}

/**
 * Options for `navigator.credentials.create({ publicKey })` (A12 step 1):
 * `rp.id` the exact app host, a discoverable credential, user verification
 * required, the PRF extension. `userId` defaults to 16 fresh random bytes and
 * `challenge` to 32 (the PRF needs no server; nothing verifies the
 * attestation). Pure data: it touches no browser API but the CSPRNG.
 */
export function passkeyCreationOptions(args: {
  rpId: string;
  rpName: string;
  userName: string;
  userDisplayName?: string;
  userId?: Uint8Array;
  challenge?: Uint8Array;
  attachment?: "platform" | "cross-platform";
  excludeCredentialIds?: readonly Uint8Array[];
  timeoutMs?: number;
}): PasskeyCreationOptions {
  checkPasskeyRpId(args.rpId);
  if (args.userId !== undefined && (args.userId.length < 1 || args.userId.length > 64)) throw new RangeError("user id must be 1..64 bytes");
  if (args.challenge !== undefined && args.challenge.length < 16) throw new RangeError("challenge must be at least 16 bytes");
  return {
    rp: { id: args.rpId, name: args.rpName },
    user: { id: args.userId === undefined ? randomBuffer(16) : bufferBytes(args.userId), name: args.userName, displayName: args.userDisplayName ?? args.userName },
    challenge: args.challenge === undefined ? randomBuffer(32) : bufferBytes(args.challenge),
    pubKeyCredParams: [
      { type: "public-key", alg: -8 },
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
      ...(args.attachment === undefined ? {} : { authenticatorAttachment: args.attachment }),
    },
    hints: ["client-device", "security-key"],
    attestation: "none",
    timeout: args.timeoutMs ?? 120_000,
    excludeCredentials: (args.excludeCredentialIds ?? []).map((id) => ({ type: "public-key" as const, id: bufferBytes(id) })),
    extensions: { prf: {} },
  };
}

/** `PublicKeyCredentialRequestOptions` (structurally) evaluating the PQ PRF. */
export interface PasskeyRequestOptions {
  rpId: string;
  challenge: Uint8Array<ArrayBuffer>;
  userVerification: "required";
  timeout: number;
  allowCredentials: { type: "public-key"; id: Uint8Array<ArrayBuffer> }[];
  hints: string[];
  extensions: { prf: { eval: { first: Uint8Array<ArrayBuffer> } } };
}

/** UTF-8 bytes of `PASSKEY_PRF_SALT` (a fresh copy). */
export function passkeyPrfSalt(): Uint8Array<ArrayBuffer> {
  return bufferBytes(utf8(PASSKEY_PRF_SALT));
}

/**
 * Options for `navigator.credentials.get({ publicKey })` (A12 step 2): user
 * verification required and `prf.eval.first = UTF-8 PASSKEY_PRF_SALT`.
 * Pass the credential id the identity was made with (`credentialIds`): with
 * none, the user picks any passkey of the site, and another passkey derives
 * another identity. Then `passkeyPrfFromAssertion`.
 */
export function passkeyRequestOptions(args: { rpId: string; challenge?: Uint8Array; credentialIds?: readonly Uint8Array[]; timeoutMs?: number }): PasskeyRequestOptions {
  checkPasskeyRpId(args.rpId);
  if (args.challenge !== undefined && args.challenge.length < 16) throw new RangeError("challenge must be at least 16 bytes");
  return {
    rpId: args.rpId,
    challenge: args.challenge === undefined ? randomBuffer(32) : bufferBytes(args.challenge),
    userVerification: "required",
    timeout: args.timeoutMs ?? 120_000,
    allowCredentials: (args.credentialIds ?? []).map((id) => ({ type: "public-key" as const, id: bufferBytes(id) })),
    hints: ["client-device", "security-key"],
    extensions: { prf: { eval: { first: passkeyPrfSalt() } } },
  };
}

// --------------------------------------------------------------- accounts ---
// Addresses: `identityAddress(lmsPublicKey)`, `identityAddressFromId(id)`
// and `attestationAddress(launch)` in `../pda.ts`. Accounts:
// `decodeIdentity` / `fetchIdentity` and `decodeAttestation` /
// `fetchAttestation` in `../launch/accounts.ts` (`IdentityAccount.used` is
// the bitmap the leaf functions below take).

/** Bytes of an identity's used-leaf bitmap (1,024 bits, least significant bit first). */
export const LEAF_BITMAP_LEN = PQ_IDENTITY.LEAF_BITMAP_LEN;

/**
 * Whether the attestation records `message`: it attests (version 3, launch
 * set) and its `messageHash` is SHA-256 of `message`. What a client checks
 * after landing instead of assuming its landing attested: a valid signature
 * over anything lands, and burns its leaf without attesting when the
 * identity, metadata record or window does not attest.
 */
export function attestationAttestsMessage(attestation: Pick<AttestationAccount, "attested" | "messageHash">, message: Uint8Array): boolean {
  return attestation.attested === true && bytesEqual(attestation.messageHash, sha256(message));
}

/**
 * Events of `attest_launch`, `pq_authorize` and `publish_rules`, decoded
 * from `discriminator || payload` (the "Program data:" log bytes).
 * `LaunchAttested` carries the attested `rulesHash` (all zero: no rules).
 */
export type PqAttestEvent =
  | {
      readonly name: "LaunchAttested";
      readonly launch: PublicKey;
      readonly pqIdentity: Uint8Array;
      readonly leaf: number;
      readonly metadataHash: Uint8Array;
      readonly rulesHash: Uint8Array;
      readonly slot: bigint;
      readonly notBefore: bigint;
      readonly notAfter: bigint;
    }
  | { readonly name: "PqLeafConsumed"; readonly pqIdentity: Uint8Array; readonly leaf: number; readonly launch: PublicKey }
  | {
      readonly name: "Authorized";
      readonly launch: PublicKey;
      readonly authorization: PublicKey;
      readonly pqIdentity: Uint8Array;
      readonly kind: number;
      readonly payloadHash: Uint8Array;
      readonly leaf: number;
      readonly unixTime: bigint;
      readonly slot: bigint;
    }
  | { readonly name: "RulesPublished"; readonly launch: PublicKey; readonly rules: PublicKey; readonly rulesHash: Uint8Array; readonly len: number };

/** Decode a `LaunchAttested`, `PqLeafConsumed`, `Authorized` or `RulesPublished` event (IDL-driven); `null` for any other bytes. */
export function decodePqAttestEvent(data: Uint8Array): PqAttestEvent | null {
  const codec = idlCodecs().launchpad;
  for (const name of ["LaunchAttested", "PqLeafConsumed", "Authorized", "RulesPublished"] as const) {
    const ev = codec.idl.events?.find((e) => e.name === name);
    if (ev === undefined) throw new Error(`the launchpad IDL has no ${name} event`);
    const disc = Uint8Array.from(ev.discriminator);
    if (data.length > disc.length && bytesEqual(data.subarray(0, disc.length), disc)) {
      return { name, ...codec.decodeType<object>(name, data.subarray(disc.length)) } as PqAttestEvent;
    }
  }
  return null;
}

// ----------------------------------------------------------------- leaves ---

/** Domain tag of the leaf probe. */
export const LEAF_PROBE_TAG = PQ_IDENTITY.LEAF_PROBE_TAG;
/** A13: warn the user once this many leaves of an identity are used. */
export const LEAF_WARN_AT_USED = PQ_IDENTITY.LEAF_WARN_AT_USED;

const LEAF_PROBE = utf8(LEAF_PROBE_TAG);

function checkBitmap(used: Uint8Array): void {
  checkBytes("leaf bitmap", used, LEAF_BITMAP_LEN);
}

function checkLeafIndex(q: number): void {
  if (!isUint(q, LMS_LEAVES - 1)) throw new RangeError(`leaf must be in 0..${LMS_LEAVES - 1}`);
}

/** Whether leaf `q` is set in `used` (least significant bit first). */
export function leafUsed(used: Uint8Array, q: number): boolean {
  checkBitmap(used);
  checkLeafIndex(q);
  return (used[q >> 3]! & (1 << (q & 7))) !== 0;
}

/** Set leaf `q` in `used` (a local copy); false if it already was set. */
export function markLeafUsed(used: Uint8Array, q: number): boolean {
  if (leafUsed(used, q)) return false;
  used[q >> 3]! |= 1 << (q & 7);
  return true;
}

/** Bits set in the bitmap. */
export function usedLeafCount(used: Uint8Array): number {
  checkBitmap(used);
  let n = 0;
  for (let b of used) {
    while (b !== 0) {
      b &= b - 1;
      n++;
    }
  }
  return n;
}

/** The used leaves, ascending. */
export function usedLeaves(used: Uint8Array): number[] {
  checkBitmap(used);
  const out: number[] = [];
  for (let q = 0; q < LMS_LEAVES; q++) if ((used[q >> 3]! & (1 << (q & 7))) !== 0) out.push(q);
  return out;
}

/**
 * @deprecated The RETIRED public leaf probe v1 (kept for the reference
 * vectors only; the SDK no longer chooses leaves with it):
 * `u16be(SHA256("phalanx/pq/identity/leaf" || I || message)[0..2]) mod 1024`
 * for the key whose identifier is `id` (`I`, the public key's bytes 8..24).
 * Anyone can compute it, and it skipped every leaf an RPC reported as used,
 * so a dishonest RPC could steer a second device onto the leaf of a withheld
 * signature (audit 4, ID-F1). Since 0.9.0 a message's leaf starts at the
 * SECRET probe (`LmsKeyPair.leafProbeStart`, `chooseLeaf`).
 */
export function leafProbeStart(id: Uint8Array, message: Uint8Array): number {
  checkBytes("I", id, 16);
  if (!(message instanceof Uint8Array)) throw new TypeError("message must be a Uint8Array");
  const h = sha256(concatBytes([LEAF_PROBE, id, message]));
  return ((h[0]! << 8) | h[1]!) % LMS_LEAVES;
}

/**
 * The first leaf from `start`, stepping +1 with wrap-around, that is clear in
 * `used` and not `taken` (leaves in the client's records); `null` when none
 * is left. The retired v1 rule (reference vectors): since 0.9.0 `chooseLeaf`
 * never lets on-chain bits move the choice (audit 4, ID-F1).
 */
export function nextFreeLeaf(used: Uint8Array, start: number, taken: (q: number) => boolean = () => false): number | null {
  checkBitmap(used);
  checkLeafIndex(start);
  for (let i = 0; i < LMS_LEAVES; i++) {
    const q = (start + i) % LMS_LEAVES;
    if ((used[q >> 3]! & (1 << (q & 7))) === 0 && !taken(q)) return q;
  }
  return null;
}

/** The leaf for a message, with what the UI shows about the identity's usage. */
export interface LeafChoice {
  /** The leaf to reserve, or `null` when the identity is exhausted. */
  readonly leaf: number | null;
  /** Where the secret probe v2 started for this message (`LmsKeyPair.leafProbeStart`). */
  readonly probeStart: number;
  /** Leaves set on-chain. */
  readonly usedCount: number;
  /** At least `LEAF_WARN_AT_USED` leaves used (on-chain or in the records). */
  readonly warn: boolean;
  /** No leaf left: move to the next identity index. */
  readonly exhausted: boolean;
  /**
   * Leaves set on-chain that this ledger and this process never signed at
   * (another device, a cleared store, or an RPC that lies). While there is
   * one, no new signature is made (`selectLeaf` throws `UnknownLeavesError`).
   */
  readonly unknownUsed: readonly number[];
  /** The chosen leaf's bit is set on-chain (it is then also in `unknownUsed`): never signed at. */
  readonly leafSetOnChain: boolean;
}

/**
 * The leaf `keyPair` must sign `message` at (audit 4, ID-F1): the first leaf
 * from the SECRET probe start (`keyPair.leafProbeStart(message)`), stepping
 * +1 with wrap-around, that is not `taken` (the leaves in the client's
 * records and those this process signed). The on-chain bitmap `used` never
 * moves the choice: it is only compared (`leafSetOnChain`, `unknownUsed`),
 * so an RPC that reports fake used leaves cannot steer a message onto the
 * leaf of a withheld signature.
 */
export function chooseLeaf(keyPair: LmsKeyPair, message: Uint8Array, used: Uint8Array, taken: Iterable<number> = []): LeafChoice {
  if (!(keyPair instanceof LmsKeyPair)) {
    throw new TypeError("chooseLeaf needs the identity's LmsKeyPair (since 0.9.0 the leaf probe is secret: it is derived from the identity's SEED)");
  }
  checkBitmap(used);
  const takenSet = new Set(taken);
  const probeStart = keyPair.leafProbeStart(message);
  let leaf: number | null = null;
  for (let i = 0; i < LMS_LEAVES; i++) {
    const q = (probeStart + i) % LMS_LEAVES;
    if (!takenSet.has(q)) {
      leaf = q;
      break;
    }
  }
  const usedCount = usedLeafCount(used);
  let both = usedCount;
  for (const q of takenSet) if (isUint(q, LMS_LEAVES - 1) && !leafUsed(used, q)) both++;
  const unknownUsed = usedLeaves(used).filter((q) => !takenSet.has(q));
  return { leaf, probeStart, usedCount, warn: both >= LEAF_WARN_AT_USED, exhausted: leaf === null, unknownUsed, leafSetOnChain: leaf !== null && leafUsed(used, leaf) };
}

// ---------------------------------------------------------------- message ---

/** Domain tag that starts every attestation message (version 3). */
export const ATTEST_MESSAGE_TAG = PQ_IDENTITY.ATTEST_MESSAGE_TAG;
/** Domain tag of `metadataHashV2` (`pq::metadata_hash_v2`). */
export const METADATA_HASH_TAG = PQ_IDENTITY.METADATA_HASH_TAG;
/** `tag (13) || 6 x 32 || 2 x 8` = 221. */
export const ATTEST_MESSAGE_LEN = PQ_IDENTITY.ATTEST_MESSAGE_LEN;

const ATTEST_TAG = utf8(ATTEST_MESSAGE_TAG);

/** The fields of an attestation message (v3). */
export interface AttestationMessageFields {
  /** The launchpad program id (default `PROGRAM_IDS.launchpad`). */
  readonly programId?: PublicKey;
  readonly launch: PublicKey;
  /** The launch's `params_hash` (32 bytes). */
  readonly paramsHash: Uint8Array;
  readonly creator: PublicKey;
  /** `metadataHashV2` of the on-chain record `launch` will use (`pq::metadata_hash_v2`). */
  readonly metadataHash: Uint8Array;
  /**
   * `rulesHash` of the creator rules record `launch` will install
   * (`SHA256("PHX-RULES-V1" || PXR1 bytes)`); all zero (the default) for
   * no rules.
   */
  readonly rulesHash?: Uint8Array;
  /** Unix SECONDS (never `Date.now()` milliseconds), inclusive. */
  readonly notBefore: bigint;
  readonly notAfter: bigint;
}

function i64le(name: string, v: bigint): Uint8Array {
  if (typeof v !== "bigint") throw new TypeError(`${name} must be a bigint (unix seconds)`);
  if (v < I64_MIN || v > I64_MAX) throw new RangeError(`${name} out of i64 range`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
}

/** The 221-byte message v3 the launch's identity signs (`pq::attestation_message`). */
export function attestationMessage(f: AttestationMessageFields): Uint8Array {
  checkBytes("paramsHash", f.paramsHash, 32);
  checkBytes("metadataHash", f.metadataHash, 32);
  const rulesHash = f.rulesHash ?? new Uint8Array(32);
  checkBytes("rulesHash", rulesHash, 32);
  const msg = concatBytes([
    ATTEST_TAG,
    (f.programId ?? PROGRAM_IDS.launchpad).toBytes(),
    f.launch.toBytes(),
    f.paramsHash,
    f.creator.toBytes(),
    f.metadataHash,
    rulesHash,
    i64le("notBefore", f.notBefore),
    i64le("notAfter", f.notAfter),
  ]);
  if (msg.length !== ATTEST_MESSAGE_LEN) throw new Error("attestation message length mismatch");
  return msg;
}

/** The fields of a 221-byte attestation message v3 (throws on another length or tag: a retired v2 message too). */
export function parseAttestationMessage(msg: Uint8Array): Required<AttestationMessageFields> {
  checkBytes("attestation message", msg, ATTEST_MESSAGE_LEN);
  if (!bytesEqual(msg.subarray(0, ATTEST_TAG.length), ATTEST_TAG)) throw new Error(`not a ${ATTEST_MESSAGE_TAG} message`);
  const at = (i: number) => ATTEST_TAG.length + 32 * i;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  return {
    programId: new PublicKey(msg.slice(at(0), at(1))),
    launch: new PublicKey(msg.slice(at(1), at(2))),
    paramsHash: msg.slice(at(2), at(3)),
    creator: new PublicKey(msg.slice(at(3), at(4))),
    metadataHash: msg.slice(at(4), at(5)),
    rulesHash: msg.slice(at(5), at(6)),
    notBefore: view.getBigInt64(at(6), true),
    notAfter: view.getBigInt64(at(6) + 8, true),
  };
}

// ------------------------------------------------- authorization message ---

/** Domain tag of every authorization message (`pq_authorize`). */
export const AUTH_MESSAGE_TAG = AUTHORIZATION.MESSAGE_TAG;
/** `tag (11) || 3 x 32 || u8 kind || 32` = 140. */
export const AUTH_MESSAGE_LEN = AUTHORIZATION.MESSAGE_LEN;

const AUTH_TAG = utf8(AUTH_MESSAGE_TAG);

/** The fields of an authorization message (`pq::authorization_message`). */
export interface AuthorizationMessageFields {
  /** The launchpad program id (default `PROGRAM_IDS.launchpad`). */
  readonly programId?: PublicKey;
  readonly launch: PublicKey;
  /** The launch's creator (from the `Launch` account). */
  readonly creator: PublicKey;
  /** 1 activate a graph, 2 freeze it, 3 revoke its operator (any byte is signable; the autopilot reads only these). */
  readonly kind: number;
  /** What is authorized (`activationPayload`, `freezePayload`, `revokePayload`). */
  readonly payloadHash: Uint8Array;
}

/** The 140-byte message a launch's identity signs to authorize `kind` over `payloadHash` (`pq::authorization_message`). */
export function authorizationMessage(f: AuthorizationMessageFields): Uint8Array {
  if (!Number.isInteger(f.kind) || f.kind < 0 || f.kind > 255) throw new RangeError("kind must be a byte");
  checkBytes("payloadHash", f.payloadHash, 32);
  const msg = concatBytes([AUTH_TAG, (f.programId ?? PROGRAM_IDS.launchpad).toBytes(), f.launch.toBytes(), f.creator.toBytes(), Uint8Array.of(f.kind), f.payloadHash]);
  if (msg.length !== AUTH_MESSAGE_LEN) throw new Error("authorization message length mismatch");
  return msg;
}

/** The fields of a 140-byte authorization message (throws on another length or tag). */
export function parseAuthorizationMessage(msg: Uint8Array): Required<AuthorizationMessageFields> {
  checkBytes("authorization message", msg, AUTH_MESSAGE_LEN);
  if (!bytesEqual(msg.subarray(0, AUTH_TAG.length), AUTH_TAG)) throw new Error(`not a ${AUTH_MESSAGE_TAG} message`);
  const at = (i: number) => AUTH_TAG.length + 32 * i;
  return {
    programId: new PublicKey(msg.slice(at(0), at(1))),
    launch: new PublicKey(msg.slice(at(1), at(2))),
    creator: new PublicKey(msg.slice(at(2), at(3))),
    kind: msg[at(3)]!,
    payloadHash: msg.slice(at(3) + 1, at(3) + 33),
  };
}

// ------------------------------------------------------------ the window ---

// The window bounds as bigints (the same values as `POLICY`). The window and clock helpers themselves
// (`launchWindowIsValid`, `validateLaunchWindow`, `defaultLaunchWindow`, `unixNowSecs`, `clusterUnixTime`)
// are exported once, from the package root (`../launch/window.ts`).
export { MAX_LAUNCH_LEAD_SECS, MAX_LAUNCH_WINDOW_SECS, MIN_LAUNCH_WINDOW_SECS } from "../launch/window.js";

/** Hex of an identity id (record keys, logs). */
export function identityIdHex(id: Uint8Array): string {
  checkBytes("identity id", id, 32);
  return toHex(id);
}

/**
 * "Your quantum key": the one post-quantum secret this app uses, for vault
 * withdrawals and for signing launches. It never comes from the wallet (a
 * quantum computer that breaks a wallet's Ed25519 key learns nothing about
 * it). Two ways to hold it, both giving the same kind of secret:
 *   - 24 words (BIP-39, 256-bit entropy) the user writes down;
 *   - a passkey (Face ID, Touch ID, Windows Hello, a security key): the
 *     WebAuthn PRF extension (CTAP2 hmac-secret) returns a per-credential
 *     secret that only the authenticator holds, after user verification. The
 *     SDK turns it into the entropy of 24 words (HKDF), so it can be written
 *     down as words too ("backup words").
 *
 * The secret (`PqMaster`: entropy and 64-byte BIP-39 seed) lives in this
 * module's memory only: never stored, sent or logged. `lock()` wipes it (and
 * the derived identity's key), and so does leaving the tab hidden for
 * `HIDDEN_LOCK_MS` or closing it. Everything derived is cluster-separated:
 * vault keys (`deriveVaultKey(master, CLUSTER, …)`, via the vault pages) and
 * the launch identity (`pqIdentity.deriveIdentity(master, CLUSTER, index)`).
 *
 * In demo builds (VITE_NOISED_MOCK=1) the passkey is SIMULATED: no
 * authenticator is asked, and its PRF output is computed from the demo
 * credential id (the backend's `demoPasskeyMaster`, lib/mock/passkey.ts, in
 * no live bundle). It runs the SDK's real checks on a synthetic assertion but
 * protects nothing; the UI labels it as a demo.
 */
import { useSyncExternalStore } from "react";

import type { PublicKey } from "@solana/web3.js";

import { browserLedgers } from "./ledger";
import {
  ADAPTER_MODE,
  demoPasskeyMaster,
  deriveVaultKey,
  masterFingerprint,
  pqIdentity,
  vaultAddress,
  type Cluster,
  type LeafLedger,
  type LedgerLock,
  type LmotsPublicKey,
  type PqIdentity,
  type PqMaster,
} from "./noised";
import { readString, writeString } from "./storage";

/** Lock after the tab has been hidden this long. */
export const HIDDEN_LOCK_MS = 5 * 60_000;

export type KeySource = "words" | "passkey";

export interface IdentityState {
  status: "idle" | "deriving" | "ready" | "error";
  /** Leaves built so far (0..1), while deriving. */
  progress: number;
  /** The identity id (`SHA256(0x21 || LMS public key)`), hex; null until derived. */
  idHex: string | null;
  error: string | null;
}

export interface PqKeyState {
  status: "locked" | "unlocked";
  source: KeySource | null;
  /** Short, non-secret fingerprint of the key, so a user can tell two keys apart. */
  fingerprint: string | null;
  identity: IdentityState;
  /** Why the key locked itself last (null: never, or the user locked it). */
  autoLocked: "hidden" | "closed" | null;
}

const IDLE: IdentityState = { status: "idle", progress: 0, idHex: null, error: null };
const LOCKED: PqKeyState = { status: "locked", source: null, fingerprint: null, identity: IDLE, autoLocked: null };

let secret: PqMaster | null = null;
let identity: PqIdentity | null = null;
/** The derivation running now, and the (cluster, index) it is for. */
let deriving: { cluster: Cluster; index: number; run: Promise<PqIdentity> } | null = null;
/** Bumps on every lock / unlock, so a derivation that finishes after a lock is thrown away. */
let generation = 0;
let snapshot: PqKeyState = LOCKED;
const listeners = new Set<() => void>();

function publish(next: PqKeyState): void {
  snapshot = next;
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The key's state, re-rendering on every change. */
export function usePqKey(): PqKeyState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

export function pqKeyState(): PqKeyState {
  return snapshot;
}

/** Subscribe outside React (tests, the vault flow). */
export function subscribePqKey(listener: () => void): () => void {
  return subscribe(listener);
}

function wipeIdentity(): void {
  identity?.keyPair.wipe();
  identity = null;
  deriving = null;
}

/** Forget the key: wipe the master and the identity's key (best effort: JavaScript strings cannot be wiped). */
export function lock(reason: PqKeyState["autoLocked"] = null): void {
  generation++;
  if (secret !== null) pqIdentity.wipeMaster(secret);
  secret = null;
  wipeIdentity();
  publish({ ...LOCKED, autoLocked: reason });
}

function adopt(next: PqMaster, source: KeySource): void {
  lock();
  secret = next;
  publish({ status: "unlocked", source, fingerprint: masterFingerprint(next.master), identity: IDLE, autoLocked: null });
  armAutoLock();
}

/** Unlock with the 24 words (validated: words, checksum). Throws on a bad phrase; nothing changes then. */
export function unlockWithWords(phrase: string): void {
  adopt(pqIdentity.importMaster(phrase), "words");
}

/**
 * The 64-byte seed vault keys are derived from, or null when locked. It is
 * the live buffer: `lock()` wipes it, and the SDK's signers, which compare
 * it with their own copy, then refuse to sign.
 */
export function vaultMaster(): Uint8Array | null {
  return secret?.master ?? null;
}

/** The 24 words that restore this key (checked to give back exactly this key). Throws when locked. */
export function backupWords(): string {
  if (secret === null) throw new Error("Unlock your quantum key first.");
  return pqIdentity.exportMasterAsPhrase(secret);
}

/**
 * The launch identity of this key on `cluster` (this build's: identities
 * are cluster-separated; LMS, 1,024 one-time leaves): from the tree cache in
 * this browser when it holds one, else built (about a second, with
 * progress). Wiped on lock.
 */
export function launchIdentity(cluster: Cluster, index = 0): Promise<PqIdentity> {
  if (secret === null) return Promise.reject(new Error("Unlock your quantum key first."));
  if (identity !== null && identity.cluster === cluster && identity.index === index && !identity.keyPair.wiped) return Promise.resolve(identity);
  if (deriving !== null && deriving.cluster === cluster && deriving.index === index) return deriving.run;
  const gen = generation;
  const master = Uint8Array.from(secret.master);
  publish({ ...snapshot, identity: { status: "deriving", progress: 0, idHex: null, error: null } });
  const run = (async (): Promise<PqIdentity> => {
    try {
      let cache: Awaited<ReturnType<typeof browserLedgers>>["trees"] | undefined;
      try {
        cache = (await browserLedgers()).trees;
      } catch {
        cache = undefined; // no tree cache: the tree is rebuilt next time
      }
      const id = await pqIdentity.deriveIdentity(master, cluster, index, {
        ...(cache === undefined ? {} : { cache }),
        onProgress: (done, total) => {
          if (gen === generation) publish({ ...snapshot, identity: { status: "deriving", progress: total === 0 ? 0 : done / total, idHex: null, error: null } });
        },
      });
      if (gen !== generation) {
        id.keyPair.wipe();
        throw new Error("The quantum key was locked while its identity was being prepared.");
      }
      identity?.keyPair.wipe();
      identity = id;
      publish({ ...snapshot, identity: { status: "ready", progress: 1, idHex: pqIdentity.identityIdHex(id.identityId), error: null } });
      return id;
    } catch (e) {
      if (gen === generation) publish({ ...snapshot, identity: { status: "error", progress: 0, idHex: null, error: e instanceof Error ? e.message : String(e) } });
      throw e;
    } finally {
      master.fill(0);
      if (gen === generation && deriving !== null && deriving.cluster === cluster && deriving.index === index) deriving = null;
    }
  })();
  deriving = { cluster, index, run };
  return run;
}

/**
 * What a launch signature needs: the launch identity of this key on
 * `cluster` and the LMS leaf ledger of this browser profile (IndexedDB, a
 * Web Lock shared by every tab), and that lock, which every quantum
 * signature also runs under (`signingLock`). Fails closed: a locked key, or a browser
 * whose ledgers cannot open (no Web Locks API, no IndexedDB), throws, and
 * nothing may be signed.
 */
export async function launchSigner(cluster: Cluster, index = 0): Promise<{ identity: PqIdentity; leaves: LeafLedger; lock: LedgerLock }> {
  const ledgers = await browserLedgers();
  return { identity: await launchIdentity(cluster, index), leaves: ledgers.leaves, lock: ledgers.lock };
}

/**
 * The public side of vault key `index` of vault account `account` for
 * `mint` on `cluster` (its private seed is wiped at once), and the vault's
 * address (the PDA of the account's genesis key). Throws when locked.
 */
export function vaultPublicKey(cluster: Cluster, mint: PublicKey, account: number, index = 0): { pk: LmotsPublicKey; keyId: Uint8Array; vault: PublicKey } {
  if (secret === null) throw new Error("Unlock your quantum key first.");
  const genesis = deriveVaultKey(secret.master, cluster, mint, account, 0);
  genesis.skSeed.fill(0);
  if (index === 0) return { pk: genesis.pk, keyId: genesis.keyId, vault: vaultAddress(mint, genesis.keyId) };
  const k = deriveVaultKey(secret.master, cluster, mint, account, index);
  k.skSeed.fill(0);
  return { pk: k.pk, keyId: k.keyId, vault: vaultAddress(mint, genesis.keyId) };
}

/** "a1b2 c3d4": the first 4 bytes of an identity id, for showing (not for comparing). */
export function shortId(idHex: string): string {
  return `${idHex.slice(0, 4)} ${idHex.slice(4, 8)}`;
}

// ------------------------------------------------------------- auto-lock ---

let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
let armed = false;

function armAutoLock(): void {
  if (armed || typeof document === "undefined") return;
  armed = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (secret !== null && hiddenTimer === null) {
        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          if (secret !== null) lock("hidden");
        }, HIDDEN_LOCK_MS);
      }
    } else if (hiddenTimer !== null) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
  });
  // Closing or navigating away: nothing of the key may outlive the page (bfcache included).
  globalThis.addEventListener?.("pagehide", () => {
    if (secret !== null) lock("closed");
  });
}

// ---------------------------------------------------------------- passkeys ---

/** A passkey made for the quantum key in this browser: its credential id is public (it only names the passkey). */
export interface SavedPasskey {
  /** base64url credential id. */
  id: string;
  createdAt: number;
  /** Simulated (demo builds): nothing protects it. */
  demo: boolean;
}

const PASSKEYS_KEY = "noised.pqkey.passkeys.v1";

export function savedPasskeys(): SavedPasskey[] {
  try {
    const v: unknown = JSON.parse(readString(PASSKEYS_KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is SavedPasskey => typeof x === "object" && x !== null && typeof (x as SavedPasskey).id === "string" && typeof (x as SavedPasskey).createdAt === "number" && typeof (x as SavedPasskey).demo === "boolean",
    );
  } catch {
    return [];
  }
}

function savePasskey(p: SavedPasskey): void {
  const list = savedPasskeys().filter((x) => x.id !== p.id);
  if (!writeString(PASSKEYS_KEY, JSON.stringify([...list, p]))) throw new Error("This browser could not remember the passkey (storage is blocked or full).");
}

/** Forget a passkey in this browser (it stays on the device; this browser just stops offering it). */
export function forgetPasskey(id: string): void {
  writeString(PASSKEYS_KEY, JSON.stringify(savedPasskeys().filter((x) => x.id !== id)));
  publish({ ...snapshot });
}

const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The WebAuthn RP ID: this page's exact host (the SDK refuses IP addresses and parent domains). */
export function passkeyRpId(): string {
  return (globalThis.location?.hostname ?? "").toLowerCase();
}

/** Whether passkeys can hold the quantum key here: `prf` "yes" when the browser says its passkeys can (then recommended). */
export interface PasskeySupport {
  available: boolean;
  prf: "yes" | "unknown" | "no";
  /** Simulated passkey (demo builds). */
  demo: boolean;
  /** Why not, when unavailable. */
  reason: string | null;
}

interface PublicKeyCredentialStatic {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
}

export async function passkeySupport(): Promise<PasskeySupport> {
  if (ADAPTER_MODE === "mock") return { available: true, prf: "yes", demo: true, reason: null };
  const PKC = (globalThis as { PublicKeyCredential?: PublicKeyCredentialStatic }).PublicKeyCredential;
  const credentials = (globalThis as { navigator?: { credentials?: { create?: unknown; get?: unknown } } }).navigator?.credentials;
  if (PKC === undefined || typeof credentials?.create !== "function" || typeof credentials.get !== "function") {
    return { available: false, prf: "no", demo: false, reason: "This browser has no passkeys here." };
  }
  try {
    pqIdentity.checkPasskeyRpId(passkeyRpId());
  } catch {
    return { available: false, prf: "no", demo: false, reason: "Passkeys need the app to be opened at its web address, not an IP address." };
  }
  let prf: PasskeySupport["prf"] = "unknown";
  try {
    const caps = await PKC.getClientCapabilities?.();
    if (caps !== undefined && "extension:prf" in caps) prf = caps["extension:prf"] === true ? "yes" : "no";
  } catch {
    prf = "unknown";
  }
  return prf === "no"
    ? { available: false, prf, demo: false, reason: "This browser's passkeys cannot hold a quantum key (no PRF support). Use 24 words." }
    : { available: true, prf, demo: false, reason: null };
}

interface CredentialLike {
  rawId: ArrayBuffer;
  response: { authenticatorData?: ArrayBuffer };
  getClientExtensionResults(): { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } };
}

/**
 * Make a passkey for a NEW quantum key and unlock it: the authenticator
 * creates a discoverable credential with the PRF extension (user
 * verification required), then one assertion evaluates the PRF and the SDK
 * derives the key from it. The passkey's id is remembered in this browser
 * to offer it next time. Throws (nothing changes) when the passkey cannot
 * hold a quantum key.
 */
export async function createWithPasskey(userName = "Noised quantum key"): Promise<void> {
  const rpId = passkeyRpId();
  if (ADAPTER_MODE === "mock") {
    const id = crypto.getRandomValues(new Uint8Array(16));
    savePasskey({ id: b64url(id), createdAt: Date.now(), demo: true });
    adopt(demoPasskeyMaster(rpId || "localhost", id), "passkey");
    return;
  }
  const creation = pqIdentity.passkeyCreationOptions({ rpId, rpName: "Noised", userName, userDisplayName: userName });
  const created = (await navigator.credentials.create({ publicKey: creation as unknown as PublicKeyCredentialCreationOptions })) as unknown as CredentialLike | null;
  if (created === null) throw new Error("No passkey was made.");
  const ext = created.getClientExtensionResults();
  if (ext.prf?.enabled === false) throw new Error("This passkey cannot hold a quantum key (no PRF support). Use 24 words instead, or another passkey.");
  const id = new Uint8Array(created.rawId);
  savePasskey({ id: b64url(id), createdAt: Date.now(), demo: false });
  await unlockWithPasskey(b64url(id));
}

/**
 * Unlock with a passkey of this browser (`id`, base64url; default: the one
 * made last): the authenticator verifies the user and evaluates the PRF; the
 * SDK checks the RP ID, the presence and verification flags and the output
 * length, then derives the key.
 */
export async function unlockWithPasskey(id?: string): Promise<void> {
  const saved = savedPasskeys();
  const pick = id === undefined ? saved[saved.length - 1] : saved.find((p) => p.id === id);
  if (pick === undefined) throw new Error("This browser knows no passkey for a quantum key. Make one, or use your 24 words.");
  const rpId = passkeyRpId();
  const credentialId = fromB64url(pick.id);
  if (pick.demo || ADAPTER_MODE === "mock") {
    if (!pick.demo || ADAPTER_MODE !== "mock") throw new Error("A demo passkey only works in the demo, and a real one only outside it.");
    adopt(demoPasskeyMaster(rpId || "localhost", credentialId), "passkey");
    return;
  }
  const request = pqIdentity.passkeyRequestOptions({ rpId, credentialIds: [credentialId] });
  const got = (await navigator.credentials.get({ publicKey: request as unknown as PublicKeyCredentialRequestOptions })) as unknown as CredentialLike | null;
  if (got === null || got.response.authenticatorData === undefined) throw new Error("The passkey did not answer.");
  adopt(pqIdentity.deriveMasterFromPasskeyAssertion({ authenticatorData: got.response.authenticatorData, clientExtensionResults: got.getClientExtensionResults() }, { rpId }), "passkey");
}

// ---------------------------------------------------------------- testing ---

/** Only for tests: the identity derived so far (null when locked or not derived). */
export function currentIdentityForTests(): PqIdentity | null {
  return identity;
}

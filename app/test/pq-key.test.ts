/**
 * "Your quantum key" (src/lib/pqKey.ts): unlocked from 24 words or a
 * passkey's PRF secret, held in this module's memory only, wiped on lock,
 * after the tab stays hidden and when the page goes away; it derives the
 * vault keys and the launch identity, both separated by cluster. The demo
 * passkey is deterministic per credential and runs the SDK's real checks.
 * Each test loads a fresh copy of the module (its state is module-level).
 */
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoPasskeyMaster } from "../src/lib/mock/passkey";
import { demoPasskeyMaster as adapterDemoPasskeyMaster, deriveVaultKey, generateRecoveryPhrase, masterFingerprint, masterFromPhrase, normalizePhrase, pqIdentity, vaultAddress } from "../src/lib/noised";

/** A fresh phrase (the all-"abandon" test phrase encodes all-zero entropy, which has no backup words). */
const TEST_PHRASE = generateRecoveryPhrase();

type PqKey = typeof import("../src/lib/pqKey");

async function fresh(): Promise<PqKey> {
  vi.resetModules();
  return import("../src/lib/pqKey");
}

class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible";
  private readonly handlers = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string): void {
    for (const fn of this.handlers.get(type) ?? []) fn();
  }
}

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
    key: (i: number) => [...stored.keys()][i] ?? null,
    get length() {
      return stored.size;
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the quantum key", () => {
  it("unlocks from 24 words, keeps the secret in memory only, and wipes it on lock", async () => {
    const k = await fresh();
    expect(k.pqKeyState()).toMatchObject({ status: "locked", fingerprint: null });
    expect(k.vaultMaster()).toBeNull();
    expect(() => k.backupWords()).toThrow(/Unlock/);
    k.unlockWithWords(TEST_PHRASE);
    const expected = masterFromPhrase(TEST_PHRASE);
    expect(k.pqKeyState()).toMatchObject({ status: "unlocked", source: "words", fingerprint: masterFingerprint(expected) });
    const master = k.vaultMaster();
    expect(master).toEqual(expected);
    expect(k.backupWords()).toBe(normalizePhrase(TEST_PHRASE));
    // Nothing about the key is written anywhere.
    expect(stored.size).toBe(0);
    k.lock();
    expect(master?.every((b) => b === 0)).toBe(true);
    expect(k.pqKeyState()).toMatchObject({ status: "locked", source: null, fingerprint: null, autoLocked: null });
    expect(k.vaultMaster()).toBeNull();
  });

  it("a phrase that does not check out changes nothing", async () => {
    const k = await fresh();
    expect(() => k.unlockWithWords("abandon ".repeat(23) + "abandon")).toThrow();
    expect(k.pqKeyState().status).toBe("locked");
  });

  it("locks itself after the tab stays hidden, and when the page is closed", async () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const page = new FakeDocument();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("addEventListener", (type: string, fn: () => void) => page.addEventListener(type, fn));
    const k = await fresh();
    k.unlockWithWords(TEST_PHRASE);
    const master = k.vaultMaster();
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    vi.advanceTimersByTime(k.HIDDEN_LOCK_MS - 1_000);
    // Back in time: the countdown stops.
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    vi.advanceTimersByTime(k.HIDDEN_LOCK_MS);
    expect(k.pqKeyState().status).toBe("unlocked");
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    vi.advanceTimersByTime(k.HIDDEN_LOCK_MS);
    expect(k.pqKeyState()).toMatchObject({ status: "locked", autoLocked: "hidden" });
    expect(master?.every((b) => b === 0)).toBe(true);
    k.unlockWithWords(TEST_PHRASE);
    page.fire("pagehide");
    expect(k.pqKeyState()).toMatchObject({ status: "locked", autoLocked: "closed" });
  });

  it("a demo passkey always gives the same key, another passkey another one, through the SDK's checks", () => {
    const one = Uint8Array.from({ length: 16 }, (_, i) => i);
    const two = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);
    const a = demoPasskeyMaster("localhost", one);
    expect(masterFingerprint(demoPasskeyMaster("localhost", one).master)).toBe(masterFingerprint(a.master));
    expect(masterFingerprint(demoPasskeyMaster("localhost", two).master)).not.toBe(masterFingerprint(a.master));
    // Its backup words restore exactly that key.
    expect(pqIdentity.importMaster(pqIdentity.exportMasterAsPhrase(a)).master).toEqual(a.master);
    // The SDK checks the RP ID it was made for.
    expect(() => pqIdentity.deriveMasterFromPasskeyAssertion({ authenticatorData: new Uint8Array(37), clientExtensionResults: {} }, { rpId: "localhost" })).toThrow();
    // Only the mock backend has it (so no live bundle carries the simulated passkey): a live build refuses.
    expect(() => adapterDemoPasskeyMaster("localhost", one)).toThrow(/no demo passkey in a live build/);
  });

  it("derives vault keys per cluster, and refuses while locked", async () => {
    const k = await fresh();
    const mint = Keypair.generate().publicKey;
    expect(() => k.vaultPublicKey("devnet", mint, 0)).toThrow(/Unlock/);
    k.unlockWithWords(TEST_PHRASE);
    const master = masterFromPhrase(TEST_PHRASE);
    const genesis = deriveVaultKey(master, "devnet", mint, 0, 0);
    const devnet = k.vaultPublicKey("devnet", mint, 0);
    expect(devnet.keyId).toEqual(genesis.keyId);
    expect(devnet.vault.equals(vaultAddress(mint, genesis.keyId))).toBe(true);
    expect(k.vaultPublicKey("mainnet", mint, 0).vault.equals(devnet.vault)).toBe(false);
    const third = k.vaultPublicKey("devnet", mint, 0, 3);
    expect(third.keyId).toEqual(deriveVaultKey(master, "devnet", mint, 0, 3).keyId);
    expect(third.vault.equals(devnet.vault)).toBe(true);
  });

  it("derives one launch identity per cluster, wiped on lock; signing a launch needs the browser's ledgers", async () => {
    const k = await fresh();
    await expect(k.launchIdentity("devnet")).rejects.toThrow(/Unlock/);
    k.unlockWithWords(TEST_PHRASE);
    const devnet = await k.launchIdentity("devnet");
    expect(k.pqKeyState().identity).toMatchObject({ status: "ready", idHex: pqIdentity.identityIdHex(devnet.identityId) });
    expect(await k.launchIdentity("devnet")).toBe(devnet);
    const mainnet = await k.launchIdentity("mainnet");
    expect(mainnet.identityId).not.toEqual(devnet.identityId);
    expect(k.shortId("a1b2c3d4e5")).toBe("a1b2 c3d4");
    // No Web Locks API here (Node): the leaf ledger cannot open, so nothing may sign a launch.
    await expect(k.launchSigner("devnet")).rejects.toMatchObject({ name: "LedgerUnavailableError" });
    k.lock();
    expect(mainnet.keyPair.wiped).toBe(true);
    expect(k.currentIdentityForTests()).toBeNull();
  }, 60_000);
});

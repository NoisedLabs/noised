/**
 * The durable key ledgers of a browser profile (src/lib/ledger.ts, M1): one
 * vault-key ledger and one LMS leaf ledger on IndexedDB, shared by every
 * tab, opened only with the Web Locks API (fail closed), with persistent
 * storage asked for, and with the withdrawals signed before the ledgers
 * existed migrated in before anything is handed out. IndexedDB and the lock
 * manager are in-memory test doubles (test/support/fakeIndexedDb.ts).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addUnverifiableKeys,
  idbLedgerStore,
  LEDGER_CHANNEL,
  LedgerUnavailableError,
  openBrowserLedgers,
  subscribeLedgers,
  unverifiableKeys,
  type LedgerEnv,
} from "../src/lib/ledger";
import { lmots } from "../src/lib/noised";
import { decodeHex, decodeKey } from "../src/lib/storage";
import { FakeIndexedDb, FakeLocks } from "./support/fakeIndexedDb";
import { signedRecord } from "./support/records";

function env(idb: FakeIndexedDb, locks: FakeLocks, extra: Partial<LedgerEnv> = {}): LedgerEnv {
  return { indexedDB: idb as unknown as IDBFactory, locks, persist: async () => true, legacy: () => [], onWrite: () => undefined, ...extra };
}

function openRaw(idb: FakeIndexedDb): Promise<IDBDatabase> {
  return new Promise((resolve) => {
    const r = idb.open("raw", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("records");
    r.onsuccess = () => resolve(r.result as unknown as IDBDatabase);
  });
}

const keyOf = (w: ReturnType<typeof signedRecord>) => {
  const key = decodeKey(w.key);
  return { key, keyId: lmots.keyId(key), info: { vault: new PublicKey(w.vault), sequence: BigInt(w.sequence), key } };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opening the ledgers (fail closed)", () => {
  it("without the Web Locks API or without IndexedDB nothing opens, so nothing can be signed", async () => {
    const idb = new FakeIndexedDb();
    await expect(openBrowserLedgers(env(idb, new FakeLocks(), { locks: null }))).rejects.toMatchObject({ name: "LedgerUnavailableError", reason: "locks" });
    await expect(openBrowserLedgers(env(idb, new FakeLocks(), { locks: {} as never }))).rejects.toBeInstanceOf(LedgerUnavailableError);
    // Nothing was even opened: the lock is checked first.
    expect(idb.opens).toBe(0);
    await expect(openBrowserLedgers(env(idb, new FakeLocks(), { indexedDB: null }))).rejects.toMatchObject({ reason: "indexeddb" });
    const broken = {
      open: () => {
        throw new Error("blocked by the browser");
      },
    } as unknown as IDBFactory;
    await expect(openBrowserLedgers(env(idb, new FakeLocks(), { indexedDB: broken }))).rejects.toMatchObject({ reason: "open", message: expect.stringMatching(/blocked by the browser/) });
  });

  it("asks the browser to keep its storage, and reports the answer (or that it could not say)", async () => {
    const persist = vi.fn(async () => true);
    expect((await openBrowserLedgers(env(new FakeIndexedDb(), new FakeLocks(), { persist }))).persisted).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect((await openBrowserLedgers(env(new FakeIndexedDb(), new FakeLocks(), { persist: async () => false }))).persisted).toBe(false);
    const refusing = async (): Promise<boolean> => {
      throw new Error("no");
    };
    expect((await openBrowserLedgers(env(new FakeIndexedDb(), new FakeLocks(), { persist: refusing }))).persisted).toBeNull();
    expect((await openBrowserLedgers(env(new FakeIndexedDb(), new FakeLocks(), { persist: null }))).persisted).toBeNull();
  });
});

describe("the IndexedDB store", () => {
  it("adds atomically: an existing key is never overwritten and the refused add aborts nothing", async () => {
    const idb = new FakeIndexedDb();
    const writes: string[] = [];
    const store = idbLedgerStore(await openRaw(idb), () => writes.push("write"));
    expect(store.singleRealmOnly).toBe(false);
    expect(await store.add("noised/a", "first")).toBe(true);
    expect(await store.add("noised/a", "second")).toBe(false);
    expect(await store.get("noised/a")).toBe("first");
    await store.put("noised/b", "x");
    expect(await store.get("missing")).toBeNull();
    expect(await store.keys("noised/")).toEqual(["noised/a", "noised/b"]);
    // A refused add is not a write: only committed writes tell the other tabs.
    expect(writes).toEqual(["write", "write"]);
  });

  it("two tabs reserving one vault key for two different withdrawals: exactly one gets it", async () => {
    const idb = new FakeIndexedDb();
    const locks = new FakeLocks();
    const tabA = await openBrowserLedgers(env(idb, locks));
    const tabB = await openBrowserLedgers(env(idb, locks));
    const mint = Keypair.generate().publicKey;
    const one = signedRecord({ mint });
    const two = signedRecord({ mint, recipient: Keypair.generate().publicKey });
    const { keyId, info } = keyOf(one);
    expect(keyOf(two).keyId).toEqual(keyId);
    const results = await Promise.all([tabA.vaultKeys.reserve(keyId, decodeHex(one.message), info), tabB.vaultKeys.reserve(keyId, decodeHex(two.message), info)]);
    expect([...results].sort()).toEqual(["conflict", "reserved"]);
    // Both tabs read the one record; the lock shared by every tab serialized them.
    const a = await tabA.vaultKeys.get(keyId);
    const b = await tabB.vaultKeys.get(keyId);
    expect(a).toEqual(b);
    expect(a?.status).toBe("reserved");
    expect(locks.requested.some((n) => n.startsWith("noised/pq/vault-ledger/v1/"))).toBe(true);
  });
});

describe("withdrawals signed before the ledgers existed", () => {
  it("are migrated before the ledgers are handed out: their keys never sign another message", async () => {
    const idb = new FakeIndexedDb();
    const legacy = signedRecord();
    const ledgers = await openBrowserLedgers(env(idb, new FakeLocks(), { legacy: () => [legacy] }));
    expect(ledgers.migration).toMatchObject({ migrated: 1, alreadyThere: 0, conflicts: [], skipped: [] });
    const { keyId, info } = keyOf(legacy);
    const held = await ledgers.vaultKeys.get(keyId);
    expect(held).toMatchObject({ status: "signed", signature: legacy.signature, message: legacy.message });
    const other = signedRecord({ mint: new PublicKey(legacy.mint) });
    expect(await ledgers.vaultKeys.reserve(keyId, decodeHex(other.message), info)).toBe("conflict");
    expect(await ledgers.meta.get("migration/last")).toMatchObject({ migrated: 1 });
    // Idempotent: the next page load finds it there.
    const again = await openBrowserLedgers(env(idb, new FakeLocks(), { legacy: () => [legacy] }));
    expect(again.migration).toMatchObject({ migrated: 0, alreadyThere: 1 });
  });

  it("a damaged record is not migrated (and says why)", async () => {
    const legacy = signedRecord();
    const damaged = { ...legacy, signature: `00${legacy.signature.slice(2)}` };
    const ledgers = await openBrowserLedgers(env(new FakeIndexedDb(), new FakeLocks(), { legacy: () => [damaged] }));
    expect(ledgers.migration.migrated).toBe(0);
    expect(ledgers.migration.skipped).toEqual([{ vault: legacy.vault, sequence: legacy.sequence, reason: expect.stringMatching(/does not verify/) as string }]);
    expect(await ledgers.vaultKeys.get(keyOf(legacy).keyId)).toBeNull();
  });
});

describe("keys another device could not export", () => {
  it("are remembered until an authenticated record of each arrives", async () => {
    const ledgers = await openBrowserLedgers(env(new FakeIndexedDb(), new FakeLocks()));
    const w = signedRecord();
    const { keyId, info } = keyOf(w);
    const hex = Buffer.from(keyId).toString("hex");
    await addUnverifiableKeys(ledgers, [hex.toUpperCase()]);
    expect(await unverifiableKeys(ledgers)).toEqual([hex]);
    expect(await ledgers.vaultKeys.reserve(keyId, decodeHex(w.message), info)).toBe("reserved");
    // Reserved is not enough: nothing proves what the other device signed.
    expect(await unverifiableKeys(ledgers)).toEqual([hex]);
    await ledgers.vaultKeys.recordSignature(keyId, decodeHex(w.message), decodeHex(w.signature), decodeKey(w.nextKey));
    expect(await unverifiableKeys(ledgers)).toEqual([]);
  });
});

describe("refreshing every tab", () => {
  it("a write in any tab reaches the others (BroadcastChannel), and so does a change of the older records (storage event)", async () => {
    let onStorage: ((e: { key: string | null }) => void) | null = null;
    vi.stubGlobal("addEventListener", (type: string, fn: (e: { key: string | null }) => void) => {
      if (type === "storage") onStorage = fn;
    });
    vi.stubGlobal("removeEventListener", () => undefined);
    const seen: string[] = [];
    const off = subscribeLedgers(() => seen.push("refresh"));
    const otherTab = new BroadcastChannel(LEDGER_CHANNEL);
    otherTab.postMessage("changed");
    await vi.waitFor(() => expect(seen).toEqual(["refresh"]));
    otherTab.close();
    expect(onStorage).not.toBeNull();
    onStorage!({ key: "noised.pq.withdrawal.v4:x:0" });
    onStorage!({ key: "noised.theme" });
    onStorage!({ key: null });
    expect(seen).toEqual(["refresh", "refresh", "refresh"]);
    off();
  });
});

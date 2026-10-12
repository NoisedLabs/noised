/**
 * The rename to Noised: what this browser kept under the project's earlier name is migrated, and every one-time key
 * it already used stays used (losing one of those records could let a key sign a second message):
 *   - Web Storage `phalanx.*` (withdrawal records, signing claims, passkeys, preferences) is copied to `noised.*`
 *     once, never overwriting, never deleting (lib/legacyStorage.ts);
 *   - the IndexedDB ledgers `phalanx-ledgers` are copied into `noised-ledgers` and stay bridged: records a tab of the
 *     earlier release writes later still bind their keys, and this release's reservations are claimed there first
 *     (lib/ledger.ts, with the SDK's legacy namespace);
 *   - launches in progress (`phalanx-launches`, holding temporary accounts' keys) are copied (lib/launchFlow.ts);
 *   - a key records file saved before the rename still imports (lib/ledgerBackup.ts).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { LEDGER_DB, LEGACY_LEDGER_DB, openBrowserLedgers, type LedgerEnv } from "../src/lib/ledger";
import { exportKeyRecords, importKeyRecords, LEGACY_KEY_RECORDS_FORMAT } from "../src/lib/ledgerBackup";
import { idbLaunchStore, LAUNCH_DB, LEGACY_LAUNCH_DB } from "../src/lib/launchFlow";
import { migrateLegacyStorage, STORAGE_MIGRATED_KEY, type StorageLike } from "../src/lib/legacyStorage";
import { createMemoryVaultKeyLedger, leafLedger, lmots, type VaultKeyLedger } from "../src/lib/noised";
import { decodeHex, decodeKey } from "../src/lib/storage";
import { FakeIndexedDb, FakeLocks } from "./support/fakeIndexedDb";
import { signedRecord } from "./support/records";

function env(idb: FakeIndexedDb, locks: FakeLocks): LedgerEnv {
  return { indexedDB: idb as unknown as IDBFactory, locks, persist: async () => true, legacy: () => [], onWrite: () => undefined };
}

class MemoryStorage implements StorageLike {
  readonly m = new Map<string, string>();
  failOn: string | null = null;
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (k === this.failOn) throw new Error("QuotaExceededError");
    this.m.set(k, v);
  }
}

const keyOf = (w: ReturnType<typeof signedRecord>) => {
  const key = decodeKey(w.key);
  return { key, keyId: lmots.keyId(key), info: { vault: new PublicKey(w.vault), sequence: BigInt(w.sequence), key } };
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** The record an earlier release kept for `w` (the same JSON; only its key carried the earlier name). */
async function earlierRecord(w: ReturnType<typeof signedRecord>): Promise<{ key: string; value: string }> {
  const ledger: VaultKeyLedger = createMemoryVaultKeyLedger();
  const { keyId, info } = keyOf(w);
  expect(await ledger.reserve(keyId, decodeHex(w.message), info)).toBe("reserved");
  await ledger.recordSignature(keyId, decodeHex(w.message), decodeHex(w.signature), decodeKey(w.nextKey));
  return { key: `phalanx/pq/vault-ledger/v1/key/${hex(keyId)}`, value: JSON.stringify(await ledger.get(keyId)) };
}

/** A browser profile as the earlier release left it: its ledgers database holding `entries`. */
function earlierBrowser(entries: { records?: [string, unknown][]; meta?: [string, unknown][]; trees?: [string, unknown][] }): FakeIndexedDb {
  const idb = new FakeIndexedDb();
  idb.databases.set(LEGACY_LEDGER_DB, {
    version: 1,
    commits: 0,
    stores: new Map([
      ["records", new Map(entries.records ?? [])],
      ["meta", new Map(entries.meta ?? [])],
      ["trees", new Map(entries.trees ?? [])],
    ]),
  });
  return idb;
}

describe("Web Storage of the earlier name", () => {
  it("is copied once, never overwriting, never deleting; write probes are skipped", () => {
    const s = new MemoryStorage();
    const w = signedRecord();
    s.m.set(`phalanx.pq.withdrawal.v4:${w.vault}:0`, JSON.stringify(w));
    s.m.set(`phalanx.pq.signing.v4:${w.vault}:1`, '{"version":4}');
    s.m.set("phalanx.pqkey.passkeys.v1", '["cred"]');
    s.m.set("phalanx.theme", "dark");
    s.m.set("noised.theme", "light"); // already chosen under the new name: kept
    s.m.set("phalanx.probe.abc", "1");
    s.m.set("other.key", "x");
    expect(migrateLegacyStorage(s)).toEqual({ copied: 3, alreadyThere: 1, failed: 0 });
    expect(s.getItem(`noised.pq.withdrawal.v4:${w.vault}:0`)).toBe(JSON.stringify(w));
    expect(s.getItem(`noised.pq.signing.v4:${w.vault}:1`)).toBe('{"version":4}');
    expect(s.getItem("noised.pqkey.passkeys.v1")).toBe('["cred"]');
    expect(s.getItem("noised.theme")).toBe("light");
    expect(s.getItem("noised.probe.abc")).toBeNull();
    // Nothing of the earlier name was removed.
    expect(s.getItem(`phalanx.pq.withdrawal.v4:${w.vault}:0`)).toBe(JSON.stringify(w));
    // Once: a record removed later under its new name is not brought back by the next page load.
    expect(s.getItem(STORAGE_MIGRATED_KEY)).not.toBeNull();
    s.m.delete(`noised.pq.withdrawal.v4:${w.vault}:0`);
    expect(migrateLegacyStorage(s)).toBeNull();
    expect(s.getItem(`noised.pq.withdrawal.v4:${w.vault}:0`)).toBeNull();
  });

  it("a copy that fails (storage full) is retried on the next load: the flag is set only after every copy", () => {
    const s = new MemoryStorage();
    s.m.set("phalanx.pq.withdrawal.v4:V:0", "{}");
    s.failOn = "noised.pq.withdrawal.v4:V:0";
    expect(migrateLegacyStorage(s)).toEqual({ copied: 0, alreadyThere: 0, failed: 1 });
    expect(s.getItem(STORAGE_MIGRATED_KEY)).toBeNull();
    s.failOn = null;
    expect(migrateLegacyStorage(s)).toEqual({ copied: 1, alreadyThere: 0, failed: 0 });
    expect(migrateLegacyStorage(null)).toBeNull();
  });
});

describe("the ledgers database of the earlier name", () => {
  it("is copied in before the ledgers are handed out: a key it used never signs another withdrawal", async () => {
    const w = signedRecord();
    const rec = await earlierRecord(w);
    const idb = earlierBrowser({ records: [[rec.key, rec.value]], meta: [["vault-keys/unverifiable", ["ab"]]], trees: [["phalanx/pq/lms-tree/v1/00", new Uint8Array([1])]] });
    const ledgers = await openBrowserLedgers(env(idb, new FakeLocks()));
    expect(ledgers.legacyDb).toEqual({ copied: { records: 1, meta: 1, trees: 1 }, alreadyThere: { records: 0, meta: 0, trees: 0 } });
    const { keyId, info } = keyOf(w);
    expect(await ledgers.vaultKeys.get(keyId)).toMatchObject({ status: "signed", signature: w.signature });
    const other = signedRecord({ mint: new PublicKey(w.mint), recipient: Keypair.generate().publicKey });
    expect(await ledgers.vaultKeys.reserve(keyId, decodeHex(other.message), info)).toBe("conflict");
    expect(await ledgers.meta.get("vault-keys/unverifiable")).toEqual(["ab"]);
    expect(await ledgers.meta.get("migration/legacy-db")).toMatchObject({ from: LEGACY_LEDGER_DB });
    // The SDK holds it under its new key too; the earlier database is left as it was.
    expect(idb.dump(LEDGER_DB, "records").has(`noised/pq/vault-ledger/v1/key/${hex(keyId)}`)).toBe(true);
    expect([...idb.dump(LEGACY_LEDGER_DB, "records").keys()]).toEqual([rec.key]);
    // The next page load copies nothing new.
    expect((await openBrowserLedgers(env(idb, new FakeLocks()))).legacyDb).toMatchObject({ copied: { records: 0, meta: 0, trees: 0 } });
  });

  it("stays bridged: a tab of the earlier release that reserves a key later still blocks it, and this release's reservations block that tab", async () => {
    const idb = earlierBrowser({});
    const ledgers = await openBrowserLedgers(env(idb, new FakeLocks()));
    // The earlier tab signs a withdrawal after this one migrated.
    const w = signedRecord();
    const rec = await earlierRecord(w);
    idb.dump(LEGACY_LEDGER_DB, "records").set(rec.key, rec.value);
    const { keyId, info } = keyOf(w);
    const other = signedRecord({ mint: new PublicKey(w.mint), recipient: Keypair.generate().publicKey });
    expect(await ledgers.vaultKeys.reserve(keyId, decodeHex(other.message), info)).toBe("conflict");
    // This release reserves another key: the earlier tab's own atomic add on that key now fails.
    const mine = signedRecord();
    const k2 = keyOf(mine);
    expect(await ledgers.vaultKeys.reserve(k2.keyId, decodeHex(mine.message), k2.info)).toBe("reserved");
    expect(idb.dump(LEGACY_LEDGER_DB, "records").has(`phalanx/pq/vault-ledger/v1/key/${hex(k2.keyId)}`)).toBe(true);
  });

  it("a browser without it gets none: nothing of the earlier name is created", async () => {
    const idb = new FakeIndexedDb();
    const ledgers = await openBrowserLedgers(env(idb, new FakeLocks()));
    expect(ledgers.legacyDb).toBeNull();
    expect(idb.databases.has(LEGACY_LEDGER_DB)).toBe(false);
    const w = signedRecord();
    const { keyId, info } = keyOf(w);
    expect(await ledgers.vaultKeys.reserve(keyId, decodeHex(w.message), info)).toBe("reserved");
    expect(idb.databases.has(LEGACY_LEDGER_DB)).toBe(false);
  });
});

describe("launches in progress of the earlier name", () => {
  it("are copied into the renamed database (never overwriting one it holds)", async () => {
    const progress = (id: string, name: string) => JSON.stringify({ v: 1, id, launch: "L", params: "{}", record: {}, name, done: false });
    const idb = new FakeIndexedDb();
    idb.databases.set(LEGACY_LAUNCH_DB, { version: 1, commits: 0, stores: new Map([["flows", new Map([["devnet:A", progress("devnet:A", "old A")], ["devnet:B", progress("devnet:B", "old B")]])]]) });
    idb.databases.set(LAUNCH_DB, { version: 1, commits: 0, stores: new Map([["flows", new Map([["devnet:B", progress("devnet:B", "new B")]])]]) });
    const store = idbLaunchStore(idb as unknown as IDBFactory);
    const all = await store.list();
    expect(all.map((p) => [p.id, p.name]).sort()).toEqual([
      ["devnet:A", "old A"],
      ["devnet:B", "new B"],
    ]);
    expect(idb.dump(LEGACY_LAUNCH_DB, "flows").size).toBe(2);
  });

  it("a browser without them gets none created", async () => {
    const idb = new FakeIndexedDb();
    expect(await idbLaunchStore(idb as unknown as IDBFactory).list()).toEqual([]);
    expect(idb.databases.has(LEGACY_LAUNCH_DB)).toBe(false);
  });
});

describe("a key records file saved before the rename", () => {
  it("still imports", async () => {
    const meta = new Map<string, unknown>();
    const a = { vaultKeys: createMemoryVaultKeyLedger(), leaves: leafLedger.createMemoryLeafLedger(), meta: { get: async (k: string) => meta.get(k), put: async (k: string, v: unknown) => void meta.set(k, v) } };
    const w = signedRecord();
    const { keyId, info } = keyOf(w);
    expect(await a.vaultKeys.reserve(keyId, decodeHex(w.message), info)).toBe("reserved");
    await a.vaultKeys.recordSignature(keyId, decodeHex(w.message), decodeHex(w.signature), decodeKey(w.nextKey));
    const { text } = await exportKeyRecords(a, { cluster: "devnet", master: null, identity: null });
    const file = JSON.parse(text) as { format: string; vaultKeys: { format: string } };
    const earlier = JSON.stringify({ ...file, format: LEGACY_KEY_RECORDS_FORMAT, vaultKeys: { ...file.vaultKeys, format: "phalanx/pq/vault-key-ledger-export/v1" } });
    const b = { vaultKeys: createMemoryVaultKeyLedger(), leaves: leafLedger.createMemoryLeafLedger(), meta: a.meta };
    expect((await importKeyRecords(b, earlier, { cluster: "devnet", identity: null })).vault).toMatchObject({ added: 1 });
    await expect(importKeyRecords(b, JSON.stringify({ ...file, format: "other/v1" }), { cluster: "devnet", identity: null })).rejects.toThrow(/not a Noised key records file/);
  });
});

/**
 * The rename to Noised: ledger records written under the earlier name (`phalanx/pq/...`, SDK 0.9.0 and
 * older) are migrated and keep binding their one-time keys (`src/pq/legacyNamespace.ts`). Losing one of them could
 * let a key sign a second message, so every path is checked: the one-time copy, reads and reservations of records an
 * earlier client writes later, reservations an earlier client would race (the legacy key is claimed first), exports
 * in the earlier format, the LMS tree cache and the signing lock.
 */
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import { fromHex, toHex } from "../src/codec/bytes.js";
import { vaultAddress } from "../src/pda.js";
import { legacyName, migrateLegacyLedgerRecords, withLegacyLock } from "../src/pq/legacyNamespace.js";
import {
  createLeafLedger,
  exportLeafRecords,
  importLeafRecords,
  LEGACY_LEAF_LEDGER_EXPORT_FORMAT,
  memoryLeafLedgerStore,
  storageLeafLedgerStore,
  type LeafLedgerExport,
  type LeafLedgerStore,
  type LedgerLock,
  type StorageLike,
} from "../src/pq/leafLedger.js";
import { legacyTreeCacheKey, lmsKeyPair, lmsKeygenSync, memoryTreeCacheStore, treeCacheKey, type LmsKeyPair } from "../src/pq/lms.js";
import { withSigningLock, signingLockName } from "../src/pq/signGuard.js";
import { deriveVaultKey, masterFromPhrase } from "../src/pq/keys.js";
import { createVaultKeyLedger, exportVaultKeyRecords, importVaultKeyRecords, LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT } from "../src/pq/vaultLedger.js";
import { withdrawMessage } from "../src/pq/withdrawMessage.js";
import * as lmots from "../src/pq/lmots.js";
import { key } from "./helpers.js";

interface LmsVectors {
  identity: { seed: string; i: string; identityId: string };
  attestation: { message: string; launch: string };
  burnOnly: { cases: { message: string }[] };
}
const V = JSON.parse(readFileSync(new URL("./vectors/lms.json", import.meta.url), "utf8")) as LmsVectors;
const id = fromHex(V.identity.identityId);
const idHex = V.identity.identityId;
const msgA = fromHex(V.attestation.message);
const msgB = fromHex(V.burnOnly.cases[0]!.message);

const LEAF_NS = "noised/pq/leaf-ledger/v1/";
const OLD_LEAF_NS = "phalanx/pq/leaf-ledger/v1/";
const VAULT_NS = "noised/pq/vault-ledger/v1/";
const OLD_VAULT_NS = "phalanx/pq/vault-ledger/v1/";

/** A leaf record exactly as SDK 0.9.0 wrote it (same JSON; only its key carried the earlier name). */
function oldLeafRecord(leaf: number, message: Uint8Array): string {
  return JSON.stringify({
    identityId: idHex,
    leaf,
    messageHash: toHex(sha256(message)),
    status: "reserved",
    launch: null,
    message: null,
    signature: null,
    landedSlot: null,
    attested: null,
    createdAt: 1,
    updatedAt: 1,
  });
}
const oldLeafKey = (leaf: number) => `${OLD_LEAF_NS}leaf/${idHex}/${String(leaf).padStart(4, "0")}`;
const newLeafKey = (leaf: number) => `${LEAF_NS}leaf/${idHex}/${String(leaf).padStart(4, "0")}`;

/** A store holding what an earlier client left: leaf 7 reserved for message A (and its message index). */
async function storeOfEarlierClient(): Promise<LeafLedgerStore> {
  const store = memoryLeafLedgerStore();
  await store.add(oldLeafKey(7), oldLeafRecord(7, msgA));
  await store.put(`${OLD_LEAF_NS}message/${idHex}/${toHex(sha256(msgA))}`, "7");
  return store;
}

describe("names", () => {
  it("only the noised/ prefix maps to the earlier phalanx/ one", () => {
    expect(legacyName("noised/pq/leaf-ledger/v1/x")).toBe("phalanx/pq/leaf-ledger/v1/x");
    expect(legacyName("other/x")).toBe("other/x");
    expect(sdk.migrateLegacyLedgerRecords).toBe(migrateLegacyLedgerRecords);
  });
});

describe("leaf ledger: records of the earlier name keep binding their leaves", () => {
  it("copies them once before the first operation, never overwrites, never deletes", async () => {
    const store = await storeOfEarlierClient();
    const before = await store.get(oldLeafKey(7));
    const ledger = createLeafLedger(store);
    // The leaf the earlier client gave to message A is taken for any other message, and "same" for A.
    expect(await ledger.reserve(id, 7, sha256(msgB))).toBe("conflict");
    expect(await ledger.reserve(id, 7, sha256(msgA))).toBe("same");
    expect(await ledger.get(id, 7)).toMatchObject({ leaf: 7, messageHash: toHex(sha256(msgA)), status: "reserved" });
    expect(await ledger.leaves(id)).toEqual([7]);
    expect((await ledger.findByMessage(id, sha256(msgA)))?.leaf).toBe(7);
    // Copied to the new namespace; the earlier record is untouched.
    expect(await store.get(newLeafKey(7))).toBe(before);
    expect(await store.get(oldLeafKey(7))).toBe(before);
    // Idempotent: a second run copies nothing.
    expect(await migrateLegacyLedgerRecords(store, LEAF_NS)).toEqual({ copied: 0, alreadyThere: 2 });
  });

  it("reports what it copied", async () => {
    const store = await storeOfEarlierClient();
    expect(await migrateLegacyLedgerRecords(store, LEAF_NS)).toEqual({ copied: 2, alreadyThere: 0 });
    await expect(migrateLegacyLedgerRecords(store, "phalanx/pq/leaf-ledger/v1/")).rejects.toThrow(/must start with noised/);
  });

  it("honours a record an earlier client writes after the migration ran (another tab still on the old release)", async () => {
    const store = memoryLeafLedgerStore();
    const ledger = createLeafLedger(store);
    expect(await ledger.leaves(id)).toEqual([]); // the one-time copy ran (nothing to copy)
    await store.add(oldLeafKey(300), oldLeafRecord(300, msgA)); // the earlier client reserves leaf 300 for A
    expect(await ledger.reserve(id, 300, sha256(msgB))).toBe("conflict");
    expect(await ledger.leaves(id)).toEqual([300]);
    expect((await ledger.get(id, 300))?.messageHash).toBe(toHex(sha256(msgA)));
    expect(await store.get(newLeafKey(300))).toBe(await store.get(oldLeafKey(300)));
  });

  it("claims the earlier name first, so an earlier client cannot reserve a leaf this one holds (and the other way round)", async () => {
    const store = memoryLeafLedgerStore();
    const ledger = createLeafLedger(store);
    expect(await ledger.reserve(id, 41, sha256(msgB))).toBe("reserved");
    // What an earlier client's reservation does: an atomic add under its own name. It is refused.
    expect(await store.add(oldLeafKey(41), oldLeafRecord(41, msgA))).toBe(false);
    expect(JSON.parse((await store.get(oldLeafKey(41)))!)).toMatchObject({ leaf: 41, messageHash: toHex(sha256(msgB)) });
    // Race lost to an earlier client between this ledger's read and its add: the reservation is refused.
    const fresh = memoryLeafLedgerStore();
    const racing: LeafLedgerStore = {
      ...fresh,
      async add(k, v) {
        if (k === oldLeafKey(42)) await fresh.add(k, oldLeafRecord(42, msgA)); // the earlier client got there first
        return fresh.add(k, v);
      },
    };
    const raced = createLeafLedger(racing);
    expect(await raced.reserve(id, 42, sha256(msgB))).toBe("conflict");
    expect((await raced.get(id, 42))?.messageHash).toBe(toHex(sha256(msgA)));
  });

  it("works on Web Storage too (the store the earlier releases' browsers used without IndexedDB)", async () => {
    const m = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
    m.set(oldLeafKey(9), oldLeafRecord(9, msgA));
    const lock: LedgerLock = (_name, fn) => fn();
    const ledger = createLeafLedger(storageLeafLedgerStore(storage), { lock });
    expect(await ledger.reserve(id, 9, sha256(msgB))).toBe("conflict");
    expect(m.get(newLeafKey(9))).toBe(m.get(oldLeafKey(9)));
  });

  it("an unreadable record under the earlier name is taken, never free", async () => {
    const store = memoryLeafLedgerStore();
    await store.add(oldLeafKey(5), "{not json");
    const ledger = createLeafLedger(store);
    expect(await ledger.reserve(id, 5, sha256(msgB))).toBe("conflict");
    expect(await ledger.leaves(id)).toEqual([5]);
  });

  it("imports an export made before the rename", async () => {
    const store = await storeOfEarlierClient();
    const exported = await exportLeafRecords(createLeafLedger(store), id);
    expect(exported.format).toBe("noised/pq/leaf-ledger-export/v1");
    const old = JSON.parse(JSON.stringify({ ...exported, format: LEGACY_LEAF_LEDGER_EXPORT_FORMAT })) as LeafLedgerExport;
    expect(LEGACY_LEAF_LEDGER_EXPORT_FORMAT).toBe("phalanx/pq/leaf-ledger-export/v1");
    const other = createLeafLedger(memoryLeafLedgerStore());
    const kp = lmsKeygenSync({ seed: fromHex(V.identity.seed), id: fromHex(V.identity.i) });
    const summary = await importLeafRecords(other, kp.publicKey, old);
    expect(await other.leaves(id)).toEqual([7]);
    expect(summary).toBeTruthy();
    await expect(importLeafRecords(other, kp.publicKey, { ...old, format: "other/v1" } as never)).rejects.toThrow(/not a leaf-ledger export/);
  });
});

describe("vault-key ledger: records of the earlier name keep binding their keys", () => {
  const master = masterFromPhrase("abandon ".repeat(23) + "art");
  const mint = key("legacy-ns/mint");
  const k0 = deriveVaultKey(master, "devnet", mint, 0, 0);
  const k1 = deriveVaultKey(master, "devnet", mint, 0, 1);
  const vault = vaultAddress(mint, k0.keyId);
  const toA = withdrawMessage(vault, mint, 0n, key("legacy-ns/alice"), 10n, k1.keyId);
  const toB = withdrawMessage(vault, mint, 0n, key("legacy-ns/bob"), 10n, k1.keyId);
  const info = { vault, sequence: 0n, key: k0.pk };
  const sk = { id: k0.pk.id, q: k0.pk.q, seed: k0.skSeed };

  /** The record SDK 0.9.0 kept for a key that signed the withdrawal to Alice (under the earlier name). */
  async function earlierStore(): Promise<LeafLedgerStore> {
    const store = memoryLeafLedgerStore();
    const earlier = createVaultKeyLedger(memoryLeafLedgerStore());
    expect(await earlier.reserve(k0.keyId, toA, info)).toBe("reserved");
    await earlier.recordSignature(k0.keyId, toA, lmots.signDeterministic(sk, toA), k1.pk);
    const rec = await earlier.get(k0.keyId);
    await store.add(`${OLD_VAULT_NS}key/${toHex(k0.keyId)}`, JSON.stringify(rec));
    return store;
  }

  it("a key that signed under the earlier name never signs another withdrawal", async () => {
    const store = await earlierStore();
    const ledger = createVaultKeyLedger(store);
    expect(await ledger.reserve(k0.keyId, toB, info)).toBe("conflict");
    expect(await ledger.reserve(k0.keyId, toA, info)).toBe("same");
    expect(await ledger.get(k0.keyId)).toMatchObject({ status: "signed", messageHash: toHex(sha256(toA)) });
    expect((await ledger.list()).map((r) => r.keyId)).toEqual([toHex(k0.keyId)]);
    expect(await store.get(`${VAULT_NS}key/${toHex(k0.keyId)}`)).toBe(await store.get(`${OLD_VAULT_NS}key/${toHex(k0.keyId)}`));
  });

  it("an earlier client cannot reserve a key this ledger reserved", async () => {
    const store = memoryLeafLedgerStore();
    const ledger = createVaultKeyLedger(store);
    expect(await ledger.reserve(k0.keyId, toB, info)).toBe("reserved");
    expect(await store.add(`${OLD_VAULT_NS}key/${toHex(k0.keyId)}`, "anything")).toBe(false);
  });

  it("imports an export made before the rename", async () => {
    const exported = await exportVaultKeyRecords(createVaultKeyLedger(await earlierStore()));
    const old = JSON.parse(JSON.stringify({ ...exported, format: LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT }));
    expect(LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT).toBe("phalanx/pq/vault-key-ledger-export/v1");
    const other = createVaultKeyLedger(memoryLeafLedgerStore());
    expect(await importVaultKeyRecords(other, old)).toMatchObject({ added: 1 });
    expect(await other.reserve(k0.keyId, toB, info)).toBe("conflict");
  });
});

describe("LMS tree cache and signing lock", () => {
  let kp: LmsKeyPair;
  const sk = { seed: fromHex(V.identity.seed), id: fromHex(V.identity.i) };
  beforeAll(() => {
    kp = lmsKeygenSync(sk);
  });

  it("a tree cache kept under the earlier key still loads (it is checked by its tag either way)", async () => {
    const cache = memoryTreeCacheStore();
    expect(legacyTreeCacheKey(sk)).toBe(`phalanx/pq/lms-tree/v1/${V.identity.i}`);
    expect(treeCacheKey(sk)).toBe(`noised/pq/lms-tree/v1/${V.identity.i}`);
    await cache.put(legacyTreeCacheKey(sk), kp.exportTreeCache());
    let progress = 0;
    const loaded = await lmsKeyPair(sk, { cache, onProgress: (done) => (progress = done), onCacheRejected: () => expect.fail("rejected") });
    expect(toHex(loaded.publicKey)).toBe(toHex(kp.publicKey));
    expect(progress).toBe(1024); // straight from the cache: no key generation
  });

  it("the signing lock is taken under the earlier name too (earlier clients take that one), outer first", async () => {
    const launch = new PublicKey(V.attestation.launch);
    const names: string[] = [];
    const lock: LedgerLock = (name, fn) => {
      names.push(name);
      return fn();
    };
    expect(await withSigningLock(launch, lock, async () => 1)).toBe(1);
    expect(names).toEqual([`phalanx/pq/sign/v1/${launch.toBase58()}`, signingLockName(launch)]);
    const ledgerNames: string[] = [];
    await withLegacyLock((n, fn) => (ledgerNames.push(n), fn()))("other/x", async () => undefined);
    expect(ledgerNames).toEqual(["other/x"]);
  });
});

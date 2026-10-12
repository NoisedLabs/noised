/**
 * Moving the records of used one-time keys between devices
 * (src/lib/ledgerBackup.ts): the file carries public data only, every vault
 * key record is authenticated by the SDK before anything is written, an
 * import only adds (a key used on the other device is used here too), keys
 * the other device could not include stop vault signing here, and a file of
 * another cluster or format is refused whole.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { addUnverifiableKeys, unverifiableKeys, type BrowserLedgers, type MetaStore } from "../src/lib/ledger";
import { exportKeyRecords, importKeyRecords, KEY_RECORDS_FORMAT, type KeyRecordsFile } from "../src/lib/ledgerBackup";
import { createMemoryVaultKeyLedger, leafLedger, lmots, VAULT_KEY_LEDGER_EXPORT_FORMAT, type VaultKeyLedger } from "../src/lib/noised";
import { decodeHex, decodeKey } from "../src/lib/storage";
import { KeyRecords } from "../src/pages/vault/KeyRecords";
import { signedRecord } from "./support/records";

function memoryMeta(): MetaStore {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) };
}

function device() {
  return { vaultKeys: createMemoryVaultKeyLedger(), leaves: leafLedger.createMemoryLeafLedger(), meta: memoryMeta() };
}

async function signInto(ledger: VaultKeyLedger, w: ReturnType<typeof signedRecord>): Promise<Uint8Array> {
  const key = decodeKey(w.key);
  const keyId = lmots.keyId(key);
  expect(await ledger.reserve(keyId, decodeHex(w.message), { vault: new PublicKey(w.vault), sequence: BigInt(w.sequence), key })).toBe("reserved");
  await ledger.recordSignature(keyId, decodeHex(w.message), decodeHex(w.signature), decodeKey(w.nextKey));
  return keyId;
}

describe("key records between devices", () => {
  it("a key used on one device is used on the other after the import, and the file holds no secret", async () => {
    const a = device();
    const w = signedRecord();
    const keyId = await signInto(a.vaultKeys, w);
    const out = await exportKeyRecords(a, { cluster: "devnet", master: null, identity: null });
    expect(out).toMatchObject({ vaultRecords: 1, leafRecords: 0, missingKeys: 0 });
    const file = JSON.parse(out.text) as KeyRecordsFile;
    expect(file).toMatchObject({ format: KEY_RECORDS_FORMAT, cluster: "devnet", leaves: [] });
    expect(out.text).not.toMatch(/feePayerSecret|skSeed|master|phrase/i);

    const b = device();
    const report = await importKeyRecords(b, out.text, { cluster: "devnet", identity: null });
    expect(report.vault).toMatchObject({ added: 1, conflicts: [], compromised: [], unverifiable: [] });
    expect((await b.vaultKeys.get(keyId))?.signature).toBe(w.signature);
    // That key can no longer sign anything else on device B.
    const other = signedRecord({ mint: new PublicKey(w.mint), recipient: Keypair.generate().publicKey });
    const key = decodeKey(w.key);
    expect(await b.vaultKeys.reserve(keyId, decodeHex(other.message), { vault: new PublicKey(w.vault), sequence: 0n, key })).toBe("conflict");
    // Importing the same file again changes nothing.
    expect((await importKeyRecords(b, out.text, { cluster: "devnet", identity: null })).vault).toMatchObject({ added: 0, unchanged: 1 });
  });

  it("refuses a tampered file whole, a file of another cluster, and anything that is not a records file", async () => {
    const a = device();
    await signInto(a.vaultKeys, signedRecord());
    await signInto(a.vaultKeys, signedRecord());
    const { text } = await exportKeyRecords(a, { cluster: "devnet", master: null, identity: null });
    const file = JSON.parse(text) as KeyRecordsFile;
    const first = file.vaultKeys.records[0]!;
    const tampered: KeyRecordsFile = {
      ...file,
      vaultKeys: { ...file.vaultKeys, records: [{ ...first, signature: `${first.signature!.slice(0, -2)}00` }, ...file.vaultKeys.records.slice(1)] },
    };
    const b = device();
    await expect(importKeyRecords(b, JSON.stringify(tampered), { cluster: "devnet", identity: null })).rejects.toThrow();
    // Nothing was written, not even the record that was fine.
    expect(await b.vaultKeys.list()).toEqual([]);
    await expect(importKeyRecords(b, text, { cluster: "mainnet", identity: null })).rejects.toThrow(/for devnet; this app is built for mainnet/);
    await expect(importKeyRecords(b, "not json", { cluster: "devnet", identity: null })).rejects.toThrow(/not JSON/);
    await expect(importKeyRecords(b, JSON.stringify({ format: "other" }), { cluster: "devnet", identity: null })).rejects.toThrow(/not a Noised key records file/);
    expect(await b.vaultKeys.list()).toEqual([]);
  });

  it("keys the other device used but could not include stop vault signing here", async () => {
    const b = device();
    const missing = "ab".repeat(32);
    const file: KeyRecordsFile = {
      format: KEY_RECORDS_FORMAT,
      cluster: "devnet",
      createdAt: 0,
      vaultKeys: { format: VAULT_KEY_LEDGER_EXPORT_FORMAT, records: [], skipped: [{ keyId: missing, reason: "no-key" }] },
      leaves: [],
    };
    const report = await importKeyRecords(b, JSON.stringify(file), { cluster: "devnet", identity: null });
    expect(report.vault.unverifiable).toEqual([missing]);
    expect(await unverifiableKeys(b)).toEqual([missing]);
    // A reservation that never signed is not carried (nothing to authenticate, nothing to avoid).
    await addUnverifiableKeys(b, []);
    expect(await unverifiableKeys(b)).toEqual([missing]);
  });

  it("brings in launch records only for the quantum key unlocked here", async () => {
    const b = device();
    const file: KeyRecordsFile = {
      format: KEY_RECORDS_FORMAT,
      cluster: "devnet",
      createdAt: 0,
      vaultKeys: { format: VAULT_KEY_LEDGER_EXPORT_FORMAT, records: [], skipped: [] },
      leaves: [{ format: leafLedger.LEAF_LEDGER_EXPORT_FORMAT, identityId: "cd".repeat(32), records: [] }],
    };
    const report = await importKeyRecords(b, JSON.stringify(file), { cluster: "devnet", identity: null });
    expect(report.leaves).toEqual([]);
    expect(report.leavesSkipped).toEqual(["cd".repeat(32)]);
  });
});

describe("the key records panel", () => {
  const render = (over: { persisted: boolean | null; conflicts: string[] }): string => {
    const ledgers = { ...device(), trees: null, persisted: over.persisted, migration: { migrated: 0, alreadyThere: 0, conflicts: over.conflicts, skipped: [] } };
    return renderToStaticMarkup(createElement(KeyRecords, { ledgers: { ledgers: ledgers as unknown as BrowserLedgers, error: null, version: 0 } }));
  };

  it("says when the browser did not promise to keep the records, and when it held two withdrawals of one key", () => {
    const quiet = render({ persisted: true, conflicts: [] });
    expect(quiet).not.toMatch(/has not promised to keep these records|signed two different withdrawals/);
    expect(render({ persisted: null, conflicts: [] })).not.toMatch(/has not promised to keep these records/);
    expect(render({ persisted: false, conflicts: [] })).toMatch(/This browser has not promised to keep these records when it runs low on space\. Save them to a file now and then\./);
    expect(render({ persisted: true, conflicts: ["ab".repeat(16)] })).toMatch(/A key signed two different withdrawals[\s\S]*two different signed withdrawals of one key/);
  });
});

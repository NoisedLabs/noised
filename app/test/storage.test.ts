/**
 * Signed PQ withdrawals (vault v4) are persisted before broadcast, one
 * localStorage key per vault AND sequence, survive a reload, are never
 * replaced by a different signature, detect tampering, and refuse to "save"
 * when the browser drops writes. Records made for another cluster move to
 * the archive. Vault v3 records are retired: listed read-only, never parsed
 * as v4 records and never imported. Signing claims are legacy: read (and
 * moved into the key ledger by the vault flow), never written.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toHex } from "../src/lib/format";
import { mockSignDeterministic } from "../src/lib/mock/lmotsSigner";
import { deriveVaultKey, lmots, masterFromPhrase, vaultAddress, withdrawMessage } from "../src/lib/noised";
import {
  archiveOtherClusterRecords,
  archiveWithdrawal,
  decodeHex,
  decodeKey,
  deleteRetiredWithdrawal,
  deleteSigningClaim,
  deleteWithdrawal,
  DifferentWithdrawalError,
  effectiveStatus,
  encodeKey,
  exportWithdrawal,
  feePayerOf,
  integrityOf,
  loadArchivedWithdrawals,
  loadRetiredWithdrawals,
  loadSigningClaims,
  loadWithdrawals,
  markRetiredRefunded,
  parseWithdrawalBackup,
  releaseSigningClaim,
  replaceWithRevealed,
  saveNewWithdrawal,
  signingClaimFor,
  storageWorks,
  subscribeWithdrawals,
  updateWithdrawal,
  withdrawalFor,
  withdrawalsOfVault,
  withdrawArgsOf,
  type SigningClaim,
  type StoredWithdrawal,
} from "../src/lib/storage";

const KEY = (vault: string, sequence: string): string => `noised.pq.withdrawal.v4:${vault}:${sequence}`;
const PHRASE = "abandon ".repeat(23) + "art";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  dropWrites = false;
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
    if (this.dropWrites) return;
    this.map.set(key, value);
  }
}

let mem: MemoryStorage;
beforeEach(() => {
  mem = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: mem, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

/** A record signed with LM-OTS directly, outside any ledger (a test-local signer: the SDK exports none). */
function signedRecord(opts: { sequence?: number; recipient?: PublicKey; maxAmount?: bigint; mint?: PublicKey } = {}): StoredWithdrawal {
  const master = masterFromPhrase(PHRASE);
  const mint = opts.mint ?? Keypair.generate().publicKey;
  const sequence = opts.sequence ?? 0;
  const recipient = opts.recipient ?? Keypair.generate().publicKey;
  const maxAmount = opts.maxAmount ?? 42n;
  const genesis = deriveVaultKey(master, "devnet", mint, 0, 0);
  const key = deriveVaultKey(master, "devnet", mint, 0, sequence);
  const next = deriveVaultKey(master, "devnet", mint, 0, sequence + 1);
  const vault = vaultAddress(mint, genesis.keyId);
  const msg = withdrawMessage(vault, mint, BigInt(sequence), recipient, maxAmount, next.keyId);
  const sig = mockSignDeterministic(key.skSeed, key.pk, msg);
  return {
    version: 4,
    mode: "live",
    cluster: "devnet",
    vault: vault.toBase58(),
    mint: mint.toBase58(),
    account: 0,
    sequence: String(sequence),
    key: encodeKey(key.pk),
    nextKey: encodeKey(next.pk),
    destinationOwner: recipient.toBase58(),
    maxAmount: maxAmount.toString(),
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

describe("signed withdrawal records (vault v4)", () => {
  it("round-trip through storage under their own (vault, sequence) key and verify", () => {
    expect(storageWorks()).toBe(true);
    const w = signedRecord();
    saveNewWithdrawal(w);
    expect(mem.getItem(KEY(w.vault, "0"))).toBe(JSON.stringify(w));
    expect(loadWithdrawals()).toEqual([w]);
    expect(withdrawalFor(new PublicKey(w.vault), 0n)).toEqual(w);
    expect(withdrawalFor(w.vault, "1")).toBeNull();
    expect(integrityOf(w)).toEqual({ ok: true, reason: null });
    expect(feePayerOf(w).secretKey).toEqual(decodeHex(w.feePayerSecret));
    expect(updateWithdrawal(w.vault, 0n, { status: "broadcast" })?.status).toBe("broadcast");
    expect(loadWithdrawals()[0]?.status).toBe("broadcast");
    // Bookkeeping updates never touch the signed fields.
    expect(loadWithdrawals()[0]?.signature).toBe(w.signature);
  });

  it("rebuild the withdraw arguments from the record", () => {
    const w = signedRecord({ sequence: 3, maxAmount: 7n });
    const a = withdrawArgsOf(w);
    expect(a.sequence).toBe(3n);
    expect(a.maxAmount).toBe(7n);
    expect(a.vault.toBase58()).toBe(w.vault);
    expect(toHex(a.nextKeyId)).toBe(toHex(lmots.keyId(decodeKey(w.nextKey))));
    expect(toHex(withdrawMessage(a.vault, a.mint, a.sequence, a.destinationOwner, a.maxAmount, a.nextKeyId))).toBe(w.message);
  });

  it("keep one record per vault and sequence, without rewriting other records", () => {
    const mint = Keypair.generate().publicKey;
    const s0 = signedRecord({ mint, sequence: 0 });
    const s1 = signedRecord({ mint, sequence: 1 });
    expect(s0.vault).toBe(s1.vault);
    saveNewWithdrawal(s1);
    const s1Text = mem.getItem(KEY(s1.vault, "1"));
    saveNewWithdrawal(s0);
    expect(mem.getItem(KEY(s1.vault, "1"))).toBe(s1Text);
    expect(withdrawalsOfVault(s0.vault).map((w) => w.sequence)).toEqual(["0", "1"]);
    deleteWithdrawal(s0.vault, 0n);
    expect(loadWithdrawals().map((w) => w.sequence)).toEqual(["1"]);
  });

  it("never replace a record with a different signature for the same vault and sequence", () => {
    const w = signedRecord();
    saveNewWithdrawal(w);
    // Saving the same signed withdrawal again is a no-op.
    expect(() => saveNewWithdrawal({ ...w, status: "funded" })).not.toThrow();
    expect(withdrawalFor(w.vault, w.sequence)?.status).toBe("signed");
    const sig = decodeHex(w.signature);
    sig[100] = (sig[100] ?? 0) ^ 1;
    expect(() => saveNewWithdrawal({ ...w, signature: toHex(sig) })).toThrow(/different signed withdrawal for this vault at sequence 0/);
    // A typed error, so a caller that just signed can discard its signature instead of offering it.
    expect(() => saveNewWithdrawal({ ...w, signature: toHex(sig) })).toThrow(DifferentWithdrawalError);
    expect(withdrawalFor(w.vault, w.sequence)?.signature).toBe(w.signature);
  });

  it("ignore a record stored under another key, and records that are not v4", () => {
    const w = signedRecord();
    mem.setItem(KEY(w.vault, "5"), JSON.stringify(w));
    mem.setItem(KEY(Keypair.generate().publicKey.toBase58(), "0"), JSON.stringify(w));
    mem.setItem(KEY(w.vault, "0"), JSON.stringify({ ...w, version: 1 }));
    expect(loadWithdrawals()).toEqual([]);
    expect(withdrawalFor(w.vault, 0n)).toBeNull();
  });

  it("archive the stored record when a different, already public withdrawal of the key replaces it", () => {
    const mint = Keypair.generate().publicKey;
    const mine = signedRecord({ mint });
    saveNewWithdrawal(mine);
    const other = { ...signedRecord({ mint }), source: "revealed" as const, status: "failed" as const };
    expect(other.signature).not.toBe(mine.signature);
    expect(() => replaceWithRevealed(mine, { ...other, source: "signed" })).toThrow(/found on chain/);
    replaceWithRevealed(mine, other);
    expect(withdrawalFor(mine.vault, 0n)?.signature).toBe(other.signature);
    const archived = loadRetiredWithdrawals();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ kind: "archived", vault: mine.vault, feePayerSecret: mine.feePayerSecret });
    expect(archived[0]?.backup).not.toContain(mine.feePayerSecret);
  });

  it("archive a record that can never execute, only if the slot still holds it, and list it as removable", () => {
    const mint = Keypair.generate().publicKey;
    const dead = signedRecord({ mint });
    saveNewWithdrawal(dead);
    const other = signedRecord({ mint });
    expect(() => archiveWithdrawal(other, "Archived: test.")).toThrow(/changed meanwhile/);
    expect(withdrawalFor(dead.vault, 0n)?.signature).toBe(dead.signature);
    archiveWithdrawal(dead, "Archived: its key is not the vault's key.");
    expect(withdrawalFor(dead.vault, 0n)).toBeNull();
    const [archived] = loadRetiredWithdrawals();
    expect(archived).toMatchObject({ kind: "archived", vault: dead.vault, reason: "Archived: its key is not the vault's key." });
    expect(archived?.backup).toContain("Never broadcast this one. Archived: its key is not the vault's key.");
    deleteRetiredWithdrawal(archived?.storageKey ?? "");
    expect(loadRetiredWithdrawals()).toEqual([]);
  });

  it("treat a demo-mode record as signed but not sent in a live build", () => {
    const w = { ...signedRecord(), mode: "mock" as const, status: "executed" as const };
    expect(effectiveStatus(w)).toBe("signed");
    expect(effectiveStatus({ ...w, mode: "live" })).toBe("executed");
  });

  it("detect an edited recipient, amount, sequence, next key or signature", () => {
    const w = signedRecord({ sequence: 2 });
    expect(integrityOf({ ...w, destinationOwner: Keypair.generate().publicKey.toBase58() }).ok).toBe(false);
    expect(integrityOf({ ...w, maxAmount: "43" }).ok).toBe(false);
    expect(integrityOf({ ...w, sequence: "3" }).ok).toBe(false);
    expect(integrityOf({ ...w, nextKey: w.key }).ok).toBe(false);
    const sig = decodeHex(w.signature);
    sig[40] = (sig[40] ?? 0) ^ 1;
    expect(integrityOf({ ...w, signature: toHex(sig) })).toEqual({ ok: false, reason: "The stored signature does not verify with the stored key." });
  });

  it("refuse to report success when the browser drops writes", () => {
    mem.dropWrites = true;
    expect(storageWorks()).toBe(false);
    expect(() => saveNewWithdrawal(signedRecord())).toThrow(/did not store/);
  });

  it("export a public backup that imports with a fresh fee payer and the same signature", () => {
    const w = signedRecord({ sequence: 4 });
    const backup = exportWithdrawal(w);
    expect(backup).not.toContain(w.feePayerSecret);
    const restored = parseWithdrawalBackup(backup);
    expect(restored).toMatchObject({ version: 4, sequence: "4", account: 0, source: "imported", status: "signed", mode: "live" });
    expect(restored.signature).toBe(w.signature);
    expect(restored.message).toBe(w.message);
    expect(restored.feePayerSecret).not.toBe(w.feePayerSecret);
    expect(integrityOf(restored).ok).toBe(true);
    expect(lmots.verify(decodeKey(restored.key), decodeHex(restored.message), decodeHex(restored.signature))).toBe(true);
    expect(() => parseWithdrawalBackup("{}")).toThrow(/Not a vault v4/);
    expect(() => parseWithdrawalBackup("not json")).toThrow(/JSON/);
  });
});

describe("legacy signing claims (written by earlier versions, read only)", () => {
  const claimOf = (w: StoredWithdrawal, message = w.message): SigningClaim => ({
    version: 4,
    cluster: w.cluster,
    vault: w.vault,
    mint: w.mint,
    account: w.account,
    sequence: w.sequence,
    message,
    createdAt: 7,
  });
  const write = (c: SigningClaim): void => mem.setItem(`noised.pq.signing.v4:${c.vault}:${c.sequence}`, JSON.stringify(c));

  it("are read back, and released only by the record of their own message", () => {
    const w = signedRecord();
    write(claimOf(w));
    expect(signingClaimFor(w.vault, 0n)).toEqual(claimOf(w));
    expect(loadSigningClaims()).toEqual([claimOf(w)]);
    // Releasing needs the claimed message.
    releaseSigningClaim(w.vault, 0n, "00".repeat(185));
    expect(signingClaimFor(w.vault, 0n)).not.toBeNull();
    // Storing the signed record of that message releases it.
    saveNewWithdrawal(w);
    expect(signingClaimFor(w.vault, 0n)).toBeNull();
  });

  it("fail closed: an unreadable claim stands for any message, and is removed only on request", () => {
    const w = signedRecord();
    mem.setItem(`noised.pq.signing.v4:${w.vault}:0`, "{not json");
    expect(signingClaimFor(w.vault, 0n)).toMatchObject({ vault: w.vault, sequence: "0", message: "" });
    expect(loadSigningClaims().map((c) => c.message)).toEqual([""]);
    releaseSigningClaim(w.vault, 0n, w.message);
    expect(loadSigningClaims()).toHaveLength(1);
    deleteSigningClaim(w.vault, 0n);
    expect(loadSigningClaims()).toEqual([]);
  });
});

describe("records made for another cluster (L2)", () => {
  it("move to the archive with the reason, stay downloadable, and are listed with the archived records for the key ledger", () => {
    const here = signedRecord();
    const there = { ...signedRecord(), cluster: "mainnet" as const };
    saveNewWithdrawal(here);
    saveNewWithdrawal(there);
    expect(archiveOtherClusterRecords("devnet")).toBe(1);
    expect(loadWithdrawals()).toEqual([here]);
    const [archived] = loadRetiredWithdrawals();
    expect(archived).toMatchObject({ kind: "archived", vault: there.vault, cluster: "mainnet" });
    expect(archived?.reason).toMatch(/signed for mainnet; this app is built for devnet/);
    // The archived signature still used its key: the key ledger migration reads it back in full.
    expect(loadArchivedWithdrawals().map((w) => w.signature)).toEqual([there.signature]);
    expect(archiveOtherClusterRecords("devnet")).toBe(0);
  });
});

describe("changes made in other tabs", () => {
  it("notify subscribers through the storage event: records, archives and signing claims, nothing else", () => {
    const target = new EventTarget();
    Object.defineProperty(globalThis, "addEventListener", { value: target.addEventListener.bind(target), configurable: true });
    Object.defineProperty(globalThis, "removeEventListener", { value: target.removeEventListener.bind(target), configurable: true });
    try {
      let calls = 0;
      const unsubscribe = subscribeWithdrawals(() => calls++);
      const storageEvent = (key: string | null): Event => Object.assign(new Event("storage"), { key });
      target.dispatchEvent(storageEvent("noised.pq.withdrawal.v4:V:0"));
      target.dispatchEvent(storageEvent("noised.pq.withdrawal.v4-archived:V:0:ab"));
      target.dispatchEvent(storageEvent("noised.pq.signing.v4:V:0"));
      target.dispatchEvent(storageEvent(null));
      expect(calls).toBe(4);
      target.dispatchEvent(storageEvent("noised.theme"));
      expect(calls).toBe(4);
      unsubscribe();
      target.dispatchEvent(storageEvent("noised.pq.signing.v4:V:0"));
      expect(calls).toBe(4);
    } finally {
      Reflect.deleteProperty(globalThis, "addEventListener");
      Reflect.deleteProperty(globalThis, "removeEventListener");
    }
  });
});

describe("retired vault v3 records", () => {
  /** A record of the v3 format (per-vault key, "PHX-PQV3" message, successor key). */
  function v3Record(): Record<string, unknown> {
    return {
      version: 1,
      mode: "mock",
      cluster: "devnet",
      vault: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      keyIndex: 0,
      vaultKey: { id: "00".repeat(16), q: 0, k: "11".repeat(32) },
      successorIndex: 1,
      successor: { id: "22".repeat(16), q: 1, k: "33".repeat(32) },
      destinationOwner: Keypair.generate().publicKey.toBase58(),
      maxAmount: "18446744073709551615",
      message: "50".repeat(177),
      signature: "ab".repeat(2176),
      feePayerSecret: toHex(Keypair.generate().secretKey),
      feePayerRefunded: false,
      status: "signed",
      lastTxSignature: null,
      lastError: null,
      createdAt: 5,
      updatedAt: 5,
    };
  }

  it("are listed read-only from both v3 formats, never as v4 records", () => {
    const perVault = v3Record();
    const listed = v3Record();
    mem.setItem(`noised.pq.withdrawal.v1:${String(perVault.vault)}`, JSON.stringify(perVault));
    mem.setItem("noised.pq.withdrawals.v1", JSON.stringify([listed]));
    expect(loadWithdrawals()).toEqual([]);
    const retired = loadRetiredWithdrawals();
    expect(retired.map((r) => r.vault).sort()).toEqual([String(perVault.vault), String(listed.vault)].sort());
    for (const r of retired) {
      expect(r.kind).toBe("v3");
      expect(r.feePayerSecret).toMatch(/^[0-9a-f]{128}$/);
      expect(r.backup).toMatch(/Retired Noised PQ vault v3 withdrawal/);
      expect(r.backup).not.toContain(r.feePayerSecret ?? "-");
    }
    // Nothing was migrated or rewritten.
    expect(mem.getItem("noised.pq.withdrawals.v1")).toBe(JSON.stringify([listed]));
  });

  it("can have their fee payer refund remembered and be removed one by one", () => {
    const a = v3Record();
    const b = v3Record();
    mem.setItem("noised.pq.withdrawals.v1", JSON.stringify([a, b]));
    const [first] = loadRetiredWithdrawals().filter((r) => r.vault === String(a.vault));
    if (!first) throw new Error("missing");
    markRetiredRefunded(first.storageKey);
    expect(loadRetiredWithdrawals().find((r) => r.vault === String(a.vault))?.feePayerRefunded).toBe(true);
    deleteRetiredWithdrawal(first.storageKey);
    expect(loadRetiredWithdrawals().map((r) => r.vault)).toEqual([String(b.vault)]);
    const [second] = loadRetiredWithdrawals();
    if (!second) throw new Error("missing");
    deleteRetiredWithdrawal(second.storageKey);
    expect(mem.getItem("noised.pq.withdrawals.v1")).toBeNull();
  });

  it("cannot be imported as a withdrawal to broadcast", () => {
    expect(() => parseWithdrawalBackup(JSON.stringify(v3Record()))).toThrow(/vault v3 backup \(PHX-PQV3\)\. Vault v3 is retired/);
  });
});

/**
 * Durable leaf records (`src/pq/leafLedger.ts`): a leaf is reserved for
 * exactly one message before any signature bytes exist, never signed for a
 * second message, and signing the same message again yields the identical
 * bytes (the vector signatures of `vectors/lms.json`).
 */
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PublicKey } from "@solana/web3.js";

import { fromHex, toHex } from "../src/codec/bytes.js";
import { attestationMessage, chooseLeaf, markLeafUsed } from "../src/pq/identity.js";
import {
  createLeafLedger,
  createMemoryLeafLedger,
  exportLeafRecords,
  holdsMessageLeaf,
  importLeafRecords,
  LEAF_LEDGER_EXPORT_FORMAT,
  LeafConflictError,
  LeafLedgerError,
  memoryLeafLedgerStore,
  pendingSignatures,
  reserveAndSign,
  selectLeaf,
  signAtNextLeaf,
  storageLeafLedgerStore,
  type LeafLedgerExport,
  type LeafLedgerStore,
  type LedgerLock,
  type StorageLike,
} from "../src/pq/leafLedger.js";
import { lmsKeygenSync, lmsVerify, signLeafWithRandomizer, type LmsKeyPair } from "../src/pq/lms.js";

type LeafLedgerModule = typeof import("../src/pq/leafLedger.js");
/**
 * Another device holding the same identity: its own module instances (its own process state, so its own
 * in-process leaf guard) and the identity's key pair loaded there (from `kp`'s authenticated tree cache).
 */
async function otherDevice(): Promise<{ L: LeafLedgerModule; kp: LmsKeyPair }> {
  vi.resetModules();
  const L = await import("../src/pq/leafLedger.js");
  const lms = await import("../src/pq/lms.js");
  const sk = { seed: fromHex(V.identity.seed), id: fromHex(V.identity.i) };
  return { L, kp: lms.lmsKeyPairFromTreeCache(sk, kp.exportTreeCache()) as unknown as LmsKeyPair };
}
import { createVaultKeyLedger } from "../src/pq/vaultLedger.js";

interface LmsVectors {
  identity: { seed: string; i: string; publicKey: string; identityId: string };
  attestation: { message: string; launch: string; leafProbeStart: number };
  signatures: { q: number; signature: string }[];
  burnOnly: { cases: { message: string }[] };
}

const V = JSON.parse(readFileSync(new URL("./vectors/lms.json", import.meta.url), "utf8")) as LmsVectors;
const message = fromHex(V.attestation.message);
const other = fromHex(V.burnOnly.cases[0]!.message);
const id = fromHex(V.identity.identityId);
const sigAt = (q: number) => V.signatures.find((s) => s.q === q)!.signature;
const empty = () => new Uint8Array(128);
const START = V.attestation.leafProbeStart;

let kp: LmsKeyPair;

beforeAll(() => {
  kp = lmsKeygenSync({ seed: fromHex(V.identity.seed), id: fromHex(V.identity.i) });
});

describe("reserve: one message per leaf, one live leaf per message", () => {
  it("reserved, then same, then conflict for another message", async () => {
    const ledger = createMemoryLeafLedger();
    const mh = sha256(message);
    expect(await ledger.reserve(id, 511, mh, { launch: V.attestation.launch })).toBe("reserved");
    expect(await ledger.reserve(id, 511, mh)).toBe("same");
    expect(await ledger.reserve(id, 511, sha256(other))).toBe("conflict");
    const rec = (await ledger.get(id, 511))!;
    expect(rec).toMatchObject({ identityId: V.identity.identityId, leaf: 511, messageHash: toHex(mh), status: "reserved", launch: V.attestation.launch, signature: null });
    // The message holds a live leaf: another leaf for it is refused.
    expect(await ledger.reserve(id, 512, mh)).toBe("conflict");
    expect(await ledger.findByMessage(id, mh)).toMatchObject({ leaf: 511 });
    // Once that leaf is burned by something else, the message may move on; the burned leaf stays reserved.
    await ledger.markBurned(id, 511);
    expect(await ledger.reserve(id, 512, mh)).toBe("reserved");
    expect(await ledger.reserve(id, 511, sha256(other))).toBe("conflict");
    expect((await ledger.list(id)).map((r) => [r.leaf, r.status])).toEqual([
      [511, "burned"],
      [512, "reserved"],
    ]);
    expect(await ledger.leaves(id)).toEqual([511, 512]);
    expect(await ledger.findByMessage(id, mh)).toMatchObject({ leaf: 512, status: "reserved" });
  });

  it("identities are independent; inputs are checked", async () => {
    const ledger = createMemoryLeafLedger();
    const otherId = new Uint8Array(32).fill(1);
    expect(await ledger.reserve(id, 5, sha256(message))).toBe("reserved");
    expect(await ledger.reserve(otherId, 5, sha256(other))).toBe("reserved");
    await expect(ledger.reserve(id, 1024, sha256(message))).rejects.toThrow(/leaf/);
    await expect(ledger.reserve(id.subarray(1), 5, sha256(message))).rejects.toThrow(/32 bytes/);
    await expect(ledger.reserve(id, 5, message)).rejects.toThrow(/SHA-256/);
    await expect(ledger.recordSignature(id, 5, message, new Uint8Array(10))).rejects.toThrow(/2508 bytes/);
  });

  it("concurrent reservations of one leaf: exactly one wins (lock, and the store's atomic add alone)", async () => {
    for (const ledger of [createMemoryLeafLedger(), createLeafLedger(memoryLeafLedgerStore(), { lock: (_name, fn) => fn() })]) {
      const results = await Promise.all([ledger.reserve(id, 77, sha256(message)), ledger.reserve(id, 77, sha256(other)), ledger.reserve(id, 77, sha256(message))]);
      expect(results.filter((r) => r === "reserved").length).toBe(1);
      const winner = (await ledger.get(id, 77))!.messageHash;
      const expected = results.map((_, i) => (i === 1 ? toHex(sha256(other)) : toHex(sha256(message)))).map((h) => (h === winner ? ["reserved", "same"] : ["conflict"]));
      results.forEach((r, i) => expect(expected[i]).toContain(r));
    }
  });

  it("the default lock serializes a store whose add is not atomic (Web Storage across awaits)", async () => {
    const m = new Map<string, string>();
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const racy: LeafLedgerStore = {
      get: async (k) => (await tick(), m.get(k) ?? null),
      add: async (k, v) => {
        const had = m.has(k);
        await tick();
        if (had) return false;
        m.set(k, v);
        return true;
      },
      put: async (k, v) => void m.set(k, v),
      keys: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)),
    };
    const ledger = createLeafLedger(racy);
    const results = await Promise.all([ledger.reserve(id, 33, sha256(message)), ledger.reserve(id, 33, sha256(other))]);
    expect(results).toEqual(["reserved", "conflict"]);
  });

  it("an unreadable record is taken, never free", async () => {
    const store = memoryLeafLedgerStore();
    const ledger = createLeafLedger(store);
    expect(await ledger.reserve(id, 9, sha256(message))).toBe("reserved");
    const key = (await store.keys("noised/pq/leaf-ledger/v1/leaf/"))[0]!;
    await store.put(key, "{not json");
    expect(await ledger.reserve(id, 9, sha256(other))).toBe("conflict");
    expect(await ledger.reserve(id, 9, sha256(message))).toBe("conflict");
    await expect(ledger.get(id, 9)).rejects.toThrow(LeafLedgerError);
    await expect(ledger.list(id)).rejects.toThrow(/not JSON/);
    expect(await ledger.leaves(id)).toEqual([9]);
    await store.put(key, JSON.stringify({ identityId: V.identity.identityId, leaf: 10 }));
    await expect(ledger.get(id, 9)).rejects.toThrow(/malformed/);
  });
});

describe("reserveAndSign: reserve, sign, record, then return", () => {
  it("signs the vector bytes, records them, and returns the identical bytes on retry", async () => {
    const ledger = createMemoryLeafLedger();
    const sig = await reserveAndSign(ledger, kp, 511, message, { launch: V.attestation.launch });
    expect(toHex(sig)).toBe(sigAt(511));
    const rec = (await ledger.get(id, 511))!;
    expect(rec).toMatchObject({ status: "signed", signature: sigAt(511), message: toHex(message) });
    // Every signature the key pair makes includes its leaf's authentication path: count those.
    const spy = vi.spyOn(kp, "authPath");
    try {
      expect(toHex(await reserveAndSign(ledger, kp, 511, message))).toBe(sigAt(511));
      expect(spy).toHaveBeenCalledTimes(1); // only to check the record
    } finally {
      spy.mockRestore();
    }
    expect((await pendingSignatures(ledger, id)).map((r) => r.leaf)).toEqual([511]);
  });

  it("never signs a second message at a leaf: no signature bytes are made", async () => {
    const ledger = createMemoryLeafLedger();
    await reserveAndSign(ledger, kp, 0, message);
    const spy = vi.spyOn(kp, "authPath");
    try {
      await expect(reserveAndSign(ledger, kp, 0, other)).rejects.toThrow(LeafConflictError);
      // The message already holds leaf 0: another leaf for it is refused too.
      await expect(reserveAndSign(ledger, kp, 1, message)).rejects.toThrow(LeafConflictError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the reservation is durable before signing, and the signature before it is returned", async () => {
    const events: string[] = [];
    const inner = memoryLeafLedgerStore();
    const store: LeafLedgerStore = {
      get: (k) => inner.get(k),
      keys: (p) => inner.keys(p),
      add: async (k, v) => {
        events.push(`add ${JSON.parse(v).status}${k.startsWith("phalanx/") ? " (earlier name)" : ""}`);
        return inner.add(k, v);
      },
      put: async (k, v) => {
        if (k.includes("/leaf/")) events.push(`put ${JSON.parse(v).status}`);
        return inner.put(k, v);
      },
    };
    // The authentication path is assembled while the signature is made (nothing else calls it here).
    const spy = vi.spyOn(kp, "authPath").mockImplementation(function (this: LmsKeyPair, q: number) {
      events.push("sign");
      spy.mockRestore();
      return kp.authPath(q);
    });
    const sig = await reserveAndSign(createLeafLedger(store), kp, 1, message);
    events.push("returned");
    // The reservation is claimed under the earlier name first (SDK legacyNamespace.ts), then its own, before signing.
    expect(events).toEqual(["add reserved (earlier name)", "add reserved", "sign", "put signed", "returned"]);
    expect(toHex(sig)).toBe(sigAt(1));
  });

  it("a store that cannot persist the reservation means nothing is signed; one that cannot persist the signature means nothing is returned", async () => {
    const failingAdd: LeafLedgerStore = { ...memoryLeafLedgerStore(), add: () => Promise.reject(new Error("quota exceeded")) };
    const spy = vi.spyOn(kp, "authPath");
    try {
      await expect(reserveAndSign(createLeafLedger(failingAdd), kp, 2, message)).rejects.toThrow(/quota/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const base = memoryLeafLedgerStore();
    const failingPut: LeafLedgerStore = {
      ...base,
      put: (k, v) => (k.includes("/leaf/") ? Promise.reject(new Error("disk full")) : base.put(k, v)),
    };
    await expect(reserveAndSign(createLeafLedger(failingPut), kp, 2, message)).rejects.toThrow(/disk full/);
  });

  it("refuses a recorded signature that is not this key's deterministic one, and a different second signature", async () => {
    const store = memoryLeafLedgerStore();
    const ledger = createLeafLedger(store);
    await reserveAndSign(ledger, kp, 512, message);
    // Another randomizer at the same leaf: a second signature must never be recorded.
    const second = signLeafWithRandomizer(kp, 512, message, new Uint8Array(32).fill(3));
    expect(lmsVerify(kp.publicKey, message, second)).toBe(512);
    await expect(ledger.recordSignature(id, 512, message, second)).rejects.toThrow(/different signature/);
    await expect(ledger.recordSignature(id, 512, other, fromHex(sigAt(512)))).rejects.toThrow(LeafConflictError);
    await expect(ledger.recordSignature(id, 600, message, fromHex(sigAt(512)))).rejects.toThrow(/reserve it first/);
    // A tampered record is caught before it is handed out.
    const key = (await store.keys("noised/pq/leaf-ledger/v1/leaf/")).find((k) => k.endsWith("/0512"))!;
    const rec = JSON.parse((await store.get(key))!);
    await store.put(key, JSON.stringify({ ...rec, signature: toHex(second) }));
    await expect(reserveAndSign(ledger, kp, 512, message)).rejects.toThrow(/not this key's deterministic signature/);
  });

  it("never signs at a burned leaf", async () => {
    const ledger = createMemoryLeafLedger();
    expect(await ledger.reserve(id, 3, sha256(message))).toBe("reserved");
    await ledger.markBurned(id, 3);
    await expect(reserveAndSign(ledger, kp, 3, message)).rejects.toThrow(/burned and holds no signature/);
  });
});

describe("status transitions", () => {
  it("landed needs a signature; a landed leaf is never burned; a burned one never lands", async () => {
    const ledger = createMemoryLeafLedger();
    expect(await ledger.reserve(id, 4, sha256(message))).toBe("reserved");
    await expect(ledger.markLanded(id, 4)).rejects.toThrow(/no signature/);
    await expect(ledger.markBurned(id, 99)).rejects.toThrow(/reserve it first/);
    const ledger2 = createMemoryLeafLedger();
    await reserveAndSign(ledger2, kp, 511, message);
    await ledger2.markLanded(id, 511, { slot: 400_000_000n, attested: true });
    expect(await ledger2.get(id, 511)).toMatchObject({ status: "landed", landedSlot: "400000000", attested: true });
    await expect(ledger2.markBurned(id, 511)).rejects.toThrow(/landed/);
    expect(await pendingSignatures(ledger2, id)).toEqual([]);
    // Still the same bytes on a re-broadcast.
    expect(toHex(await reserveAndSign(ledger2, kp, 511, message))).toBe(sigAt(511));
    await ledger.markBurned(id, 4);
    await ledger.markBurned(id, 4);
    await expect(ledger.markLanded(id, 4)).rejects.toThrow(/burned/);
    await expect(ledger2.markLanded(id, 511, { slot: -1n })).rejects.toThrow(/slot/);
  });
});

describe("selectLeaf / signAtNextLeaf (the secret probe and the ledger only: audit 4, ID-F1)", () => {
  it("a fresh message takes its SECRET probe start; a retry takes the same leaf and the same bytes", async () => {
    const ledger = createMemoryLeafLedger();
    const start = kp.leafProbeStart(message);
    expect(start).not.toBe(START); // the retired public probe v1 of the vectors is not where it starts
    const sel = await selectLeaf(ledger, { keyPair: kp, message, used: empty() });
    expect(sel).toMatchObject({ kind: "fresh", leaf: start });
    const a = await signAtNextLeaf(ledger, kp, message, empty());
    expect(a.leaf).toBe(start);
    expect(lmsVerify(kp.publicKey, message, a.signature)).toBe(start);
    const b = await signAtNextLeaf(ledger, kp, message, empty());
    expect([b.leaf, toHex(b.signature), b.selection.kind]).toEqual([start, toHex(a.signature), "existing"]);
    // Another message never lands on a recorded leaf, even when it probes there.
    const c = await selectLeaf(ledger, { keyPair: kp, message: other, used: empty() });
    expect(c.kind).toBe("fresh");
    if (c.kind === "fresh") expect(c.leaf).not.toBe(start);
    await expect(selectLeaf(ledger, { publicKey: kp.publicKey, message, used: empty() } as never)).rejects.toThrow(/keyPair/);
  });

  it("skips recorded leaves, wrapping around; exhausted only when every leaf is recorded", async () => {
    const ledger = createMemoryLeafLedger();
    const start = kp.leafProbeStart(message);
    expect(await ledger.reserve(id, start, sha256(other))).toBe("reserved");
    expect(await ledger.reserve(id, (start + 1) % 1024, sha256(fromHex(V.burnOnly.cases[1]!.message)))).toBe("reserved");
    const s = await signAtNextLeaf(ledger, kp, message, empty());
    expect(s.leaf).toBe((start + 2) % 1024);
    const full = memoryLeafLedgerStore();
    const all = createLeafLedger(full);
    for (let q = 0; q < 1024; q++) await all.importRecord({ identityId: V.identity.identityId, leaf: q, messageHash: "00".repeat(32), status: "burned", launch: null, message: null, signature: null, landedSlot: null, attested: null, createdAt: 0, updatedAt: 0 });
    expect((await selectLeaf(all, { keyPair: kp, message: fromHex(V.burnOnly.cases[2]!.message), used: empty() })).kind).toBe("exhausted");
    await expect(signAtNextLeaf(all, kp, fromHex(V.burnOnly.cases[2]!.message), empty())).rejects.toThrow(/next identity index/);
  });

  it("on-chain bits never move the choice: a used leaf the ledger does not know refuses BEFORE anything is reserved (UnknownLeavesError, with counts)", async () => {
    const D = await otherDevice(); // a clean process: its own in-process guard
    const ledger = D.L.createMemoryLeafLedger();
    const start = D.kp.leafProbeStart(message);
    // The chosen leaf itself is set on-chain (the other device's, or a lying RPC's bit).
    const used = empty();
    markLeafUsed(used, start);
    const e = await D.L.selectLeaf(ledger, { keyPair: D.kp, message, used }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(D.L.UnknownLeavesError);
    expect(e).toMatchObject({ unknownLeaves: [start], unknownCount: 1, usedOnChain: 1, knownToLedger: 0, chosenLeaf: start, chosenLeafSetOnChain: true });
    expect((e as Error).message).toMatch(/used elsewhere/);
    await expect(D.L.signAtNextLeaf(ledger, D.kp, message, used)).rejects.toBeInstanceOf(D.L.UnknownLeavesError);
    expect(await ledger.leaves(id)).toEqual([]); // nothing reserved, nothing signed
    // Any other used leaf the ledger has no record of refuses too (another device signed with this identity).
    const elsewhere = empty();
    markLeafUsed(elsewhere, (start + 500) % 1024);
    await expect(D.L.signAtNextLeaf(ledger, D.kp, message, elsewhere)).rejects.toMatchObject({ unknownCount: 1, chosenLeafSetOnChain: false });
    // Once the user confirmed (or the other device's records were imported), the same call signs at the probe start.
    await expect(D.L.acknowledgeUnknownLeaves(ledger, D.kp.publicKey, elsewhere, { expectedCount: 2 })).rejects.toThrow(/not the 2 confirmed/);
    expect(await D.L.acknowledgeUnknownLeaves(ledger, D.kp.publicKey, elsewhere, { expectedCount: 1 })).toEqual({ added: [(start + 500) % 1024], burned: [] });
    expect(await ledger.get(id, (start + 500) % 1024)).toMatchObject({ status: "burned", signature: null, message: null });
    const s = await D.L.signAtNextLeaf(ledger, D.kp, message, elsewhere);
    expect(s.leaf).toBe(start);
    // Leaves this ledger signed are known: they never count as unknown.
    markLeafUsed(elsewhere, start);
    expect((await D.L.signAtNextLeaf(ledger, D.kp, message, elsewhere)).selection).toMatchObject({ kind: "existing", onChain: true });
    // The same in a fresh ledger of this process: the leaf this process signed is known, the acknowledged one is not.
    await expect(D.L.signAtNextLeaf(D.L.createMemoryLeafLedger(), D.kp, other, elsewhere)).rejects.toMatchObject({ unknownLeaves: [(start + 500) % 1024] });
  });

  it("a reserved (never signed) leaf whose bit got set elsewhere refuses until acknowledged, then the message moves on", async () => {
    const D = await otherDevice();
    const ledger = D.L.createMemoryLeafLedger();
    const start = D.kp.leafProbeStart(message);
    expect(await ledger.reserve(id, start, sha256(message))).toBe("reserved");
    const used = empty();
    markLeafUsed(used, start);
    await expect(D.L.selectLeaf(ledger, { keyPair: D.kp, message, used })).rejects.toMatchObject({ unknownLeaves: [start], chosenLeaf: start, chosenLeafSetOnChain: true });
    expect(await ledger.get(id, start)).toMatchObject({ status: "reserved" }); // nothing changed on the RPC's word
    expect(await D.L.acknowledgeUnknownLeaves(ledger, D.kp.publicKey, used, { expectedCount: 1 })).toEqual({ added: [], burned: [start] });
    const sel = await D.L.selectLeaf(ledger, { keyPair: D.kp, message, used });
    expect(sel).toMatchObject({ kind: "fresh", leaf: (start + 1) % 1024 });
    const s = await D.L.signAtNextLeaf(ledger, D.kp, message, used);
    expect(s.leaf).toBe((start + 1) % 1024);
  });

  it("a signed leaf whose bit is set is reported, not abandoned (check the attestation first)", async () => {
    const ledger = createMemoryLeafLedger();
    const first = await signAtNextLeaf(ledger, kp, message, empty());
    const used = empty();
    markLeafUsed(used, first.leaf);
    const sel = await selectLeaf(ledger, { keyPair: kp, message, used });
    expect(sel).toMatchObject({ kind: "existing", leaf: first.leaf, onChain: true });
    const again = await signAtNextLeaf(ledger, kp, message, used);
    expect([again.leaf, toHex(again.signature)]).toEqual([first.leaf, toHex(first.signature)]);
    expect(await ledger.get(id, first.leaf)).toMatchObject({ status: "signed" });
  });

  it("a landing that only burned its leaf releases the message: it is signed again at a new leaf (and only then); never twice at one leaf", async () => {
    const ledger = createMemoryLeafLedger();
    const first = await signAtNextLeaf(ledger, kp, message, empty());
    const used = empty();
    markLeafUsed(used, first.leaf);
    // Landed, attested or unknown: the message keeps its leaf (the same bytes, not re-sent).
    await ledger.markLanded(id, first.leaf, {});
    expect(holdsMessageLeaf((await ledger.get(id, first.leaf))!)).toBe(true);
    expect(await selectLeaf(ledger, { keyPair: kp, message, used })).toMatchObject({ kind: "existing", leaf: first.leaf, onChain: true });
    // Landed without attesting (a record missing at the landing): the next signature of the same message takes a new leaf.
    await ledger.markLanded(id, first.leaf, { attested: false });
    expect(holdsMessageLeaf((await ledger.get(id, first.leaf))!)).toBe(false);
    const sel = await selectLeaf(ledger, { keyPair: kp, message, used });
    expect(sel.kind).toBe("fresh");
    const second = await signAtNextLeaf(ledger, kp, message, used);
    expect(second.leaf).not.toBe(first.leaf);
    expect(lmsVerify(kp.publicKey, message, second.signature)).toBe(second.leaf);
    expect((await ledger.findByMessage(id, sha256(message)))?.leaf).toBe(second.leaf);
    // A rebuild of the second takes the second again, byte for byte; the first leaf is never signed again.
    const again = await signAtNextLeaf(ledger, kp, message, used);
    expect([again.leaf, toHex(again.signature)]).toEqual([second.leaf, toHex(second.signature)]);
    expect((await ledger.get(id, first.leaf))?.signature).toBe(toHex(first.signature));
    expect(holdsMessageLeaf({ status: "burned", attested: null })).toBe(false);
    expect(holdsMessageLeaf({ status: "landed", attested: true })).toBe(true);
    expect(holdsMessageLeaf({ status: "signed", attested: null })).toBe(true);
  });
});

/** Stands for `navigator.locks.request`: one mutex per name shared by every "tab" of a test. */
function sharedLock(): LedgerLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(name) ?? Promise.resolve()).then(fn, fn);
    tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  };
}

describe("Web Storage store", () => {
  const tabs = sharedLock();
  function fakeStorage(): StorageLike & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      key: (i) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    };
  }

  it("persists across ledger instances (a reload)", async () => {
    const storage = fakeStorage();
    storage.setItem("unrelated", "x");
    const sig = await reserveAndSign(createLeafLedger(storageLeafLedgerStore(storage), { lock: tabs }), kp, 1023, message);
    expect(toHex(sig)).toBe(sigAt(1023));
    const reloaded = createLeafLedger(storageLeafLedgerStore(storage), { lock: tabs });
    expect(await reloaded.reserve(id, 1023, sha256(other))).toBe("conflict");
    expect(await reloaded.findByMessage(id, sha256(message))).toMatchObject({ leaf: 1023, status: "signed", signature: sigAt(1023) });
    expect(await reloaded.leaves(id)).toEqual([1023]);
    expect(toHex(await reserveAndSign(reloaded, kp, 1023, message))).toBe(sigAt(1023));
  });

  it("finds the message after a crash between the leaf record and its index", async () => {
    const storage = fakeStorage();
    const ledger = createLeafLedger(storageLeafLedgerStore(storage), { lock: tabs });
    expect(await ledger.reserve(id, 8, sha256(message))).toBe("reserved");
    for (const k of [...storage.map.keys()]) if (k.includes("/message/")) storage.map.delete(k);
    expect(await ledger.findByMessage(id, sha256(message))).toMatchObject({ leaf: 8 });
    expect(await ledger.reserve(id, 9, sha256(message))).toBe("conflict");
  });

  it("is atomic within one tab only, so a ledger on it requires a lock shared by every tab (review finding)", async () => {
    const storage = fakeStorage();
    const store = storageLeafLedgerStore(storage);
    expect(store.singleRealmOnly).toBe(true);
    // Without a cross-tab lock, two tabs' check-then-set could both "add" one leaf: refused up front.
    expect(() => createLeafLedger(store)).toThrow(/navigator\.locks/);
    expect(() => createVaultKeyLedger(store)).toThrow(/navigator\.locks/);
    expect(() => createLeafLedger(store, { lock: "yes" as unknown as LedgerLock })).toThrow(/must be a function/);
    // Stores atomic across realms keep the in-process default.
    expect(() => createLeafLedger(memoryLeafLedgerStore())).not.toThrow();
    // Two tabs on one storage with the shared lock: one message per leaf.
    const tabA = createLeafLedger(store, { lock: tabs });
    const tabB = createLeafLedger(storageLeafLedgerStore(storage), { lock: tabs });
    const results = await Promise.all([tabA.reserve(id, 40, sha256(message)), tabB.reserve(id, 40, sha256(other))]);
    expect(results.sort()).toEqual(["conflict", "reserved"]);
  });
});

describe("one identity on several devices (review finding): export and import of leaf records", () => {
  const launch = new PublicKey(V.attestation.launch);
  /** A message of the vector's launch whose window opens at `notBefore` (a schedule moved by a few seconds). */
  const windowMessage = (notBefore: bigint): Uint8Array =>
    attestationMessage({
      launch,
      paramsHash: new Uint8Array(32).fill(3),
      creator: launch,
      metadataHash: new Uint8Array(32).fill(7),
      notBefore,
      notAfter: notBefore + 3_600n,
    });
  /** Two messages whose secret probes start at the same leaf: what two unsynced devices would both sign there (about 1 in 1,024). */
  function collidingMessages(): { m1: Uint8Array; m2: Uint8Array; leaf: number } {
    const base = 1_900_000_000n;
    const m1 = windowMessage(base);
    const leaf = chooseLeaf(kp, m1, empty()).leaf!;
    for (let k = 1n; k < 50_000n; k++) {
      const m2 = windowMessage(base + k);
      if (chooseLeaf(kp, m2, empty()).leaf === leaf) return { m1, m2, leaf };
    }
    throw new Error("no colliding window found");
  }

  it("without the other device's records both devices sign at one leaf; after an import the second device moves on", async () => {
    const { m1, m2, leaf } = collidingMessages();
    // The residual, made concrete: two devices (two processes) with empty ledgers give both messages the same leaf.
    const a = await signAtNextLeaf(createMemoryLeafLedger(), kp, m1, empty());
    const elsewhere = await otherDevice();
    const lone = await elsewhere.L.signAtNextLeaf(elsewhere.L.createMemoryLeafLedger(), elsewhere.kp, m2, empty());
    expect([a.leaf, lone.leaf]).toEqual([leaf, leaf]);
    // With device A's records imported first, device B signs m2 elsewhere.
    const deviceA = createMemoryLeafLedger();
    const signedA = await signAtNextLeaf(deviceA, kp, m1, empty());
    const exported = await exportLeafRecords(deviceA, id);
    expect(exported).toMatchObject({ format: LEAF_LEDGER_EXPORT_FORMAT, identityId: V.identity.identityId });
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported); // JSON-safe
    const B = await otherDevice();
    const deviceB = B.L.createMemoryLeafLedger();
    expect(await B.L.importLeafRecords(deviceB, B.kp.publicKey, JSON.parse(JSON.stringify(exported)))).toEqual({ added: 1, merged: 0, unchanged: 0, conflicts: [], compromised: [] });
    const b = await B.L.signAtNextLeaf(deviceB, B.kp, m2, empty());
    expect(b.leaf).not.toBe(signedA.leaf);
    expect(lmsVerify(kp.publicKey, m2, b.signature)).toBe(b.leaf);
    // Device B never signs m2 at A's leaf, and A's message keeps its leaf and bytes there too.
    await expect(B.L.reserveAndSign(deviceB, B.kp, signedA.leaf, m2)).rejects.toThrow(B.L.LeafConflictError);
    expect(toHex(await B.L.reserveAndSign(deviceB, B.kp, signedA.leaf, m1))).toBe(toHex(signedA.signature));
    // Importing again changes nothing.
    expect(await B.L.importLeafRecords(deviceB, B.kp.publicKey, exported)).toMatchObject({ added: 0, unchanged: 1, conflicts: [] });
  });

  it("a leaf both devices gave to two messages: an unsigned reservation is burned there; two signatures are reported as compromised", async () => {
    const { m1, m2, leaf } = collidingMessages();
    const deviceA = createMemoryLeafLedger();
    await reserveAndSign(deviceA, kp, leaf, m1);
    // B only reserved m2 at the leaf (it never signed): after the import it must never sign there.
    const B = await otherDevice();
    const deviceB = B.L.createMemoryLeafLedger();
    expect(await deviceB.reserve(id, leaf, sha256(m2))).toBe("reserved");
    expect(await B.L.importLeafRecords(deviceB, B.kp.publicKey, await exportLeafRecords(deviceA, id))).toMatchObject({ conflicts: [leaf], compromised: [] });
    expect(await deviceB.get(id, leaf)).toMatchObject({ status: "burned", messageHash: toHex(sha256(m2)), signature: null });
    await expect(B.L.reserveAndSign(deviceB, B.kp, leaf, m2)).rejects.toThrow(B.L.LeafLedgerError);
    const moved = await B.L.signAtNextLeaf(deviceB, B.kp, m2, empty());
    expect(moved.leaf).not.toBe(leaf);
    // Both signed (too late): the leaf is reported compromised, and nothing is overwritten.
    const C = await otherDevice();
    const deviceC = C.L.createMemoryLeafLedger();
    await C.L.reserveAndSign(deviceC, C.kp, leaf, m2);
    expect(await C.L.importLeafRecords(deviceC, C.kp.publicKey, await exportLeafRecords(deviceA, id))).toMatchObject({ conflicts: [leaf], compromised: [leaf] });
    expect(await deviceC.get(id, leaf)).toMatchObject({ status: "signed", messageHash: toHex(sha256(m2)) });
  });

  it("one process never signs two messages at one leaf, whatever ledger it is given (review finding: a fresh ledger per attempt, a stub)", async () => {
    // Regression: reserveAndSign trusted any ledger, so two fresh memory ledgers (or a three-method stub) made it a
    // raw signer: two messages at one leaf, and anyone holding both can forge an attestation at that leaf.
    const D = await otherDevice(); // a clean process for this test
    const { m1, m2, leaf } = collidingMessages();
    const sigA = await D.L.reserveAndSign(D.L.createMemoryLeafLedger(), D.kp, leaf, m1);
    expect(lmsVerify(kp.publicKey, m1, sigA)).toBe(leaf);
    const fresh = D.L.createMemoryLeafLedger();
    const e = await D.L.reserveAndSign(fresh, D.kp, leaf, m2).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(D.L.LeafConflictError);
    expect((e as Error).message).toMatch(/already signed a different message in this process/);
    expect(await fresh.leaves(id)).toEqual([]); // refused before anything was written
    // The same message at its leaf through another ledger: the identical bytes (deterministic), not a second signature.
    expect(toHex(await D.L.reserveAndSign(D.L.createMemoryLeafLedger(), D.kp, leaf, m1))).toBe(toHex(sigA));
    // signAtNextLeaf with a fresh ledger moves m2 on (the process knows the leaf is taken) instead of looping.
    const moved = await D.L.signAtNextLeaf(D.L.createMemoryLeafLedger(), D.kp, m2, empty());
    expect(moved.leaf).not.toBe(leaf);
    expect(lmsVerify(kp.publicKey, m2, moved.signature)).toBe(moved.leaf);
    // A ledger that does not keep the contract: its record must be this identity's reservation of this leaf for this message.
    const free = (moved.leaf + 1) % 1024;
    const stub = { reserve: async () => "reserved" as const, get: async () => ({ signature: null, status: "reserved" }), recordSignature: async () => undefined };
    await expect(D.L.reserveAndSign(stub as never, D.kp, free, other)).rejects.toThrow(/not this identity's reservation of this leaf for this message/);
    const lying = {
      ...stub,
      get: async () => ({ identityId: V.identity.identityId, leaf: free, messageHash: toHex(sha256(message)), status: "reserved", signature: null }),
    };
    await expect(D.L.reserveAndSign(lying as never, D.kp, free, other)).rejects.toThrow(/not this identity's reservation/);
    // The caller's buffer is copied at entry: editing it during the reservation changes nothing that is signed.
    const buf = Uint8Array.from(other);
    const store = memoryLeafLedgerStore();
    const editing = D.L.createLeafLedger({ ...store, add: async (k, v) => { buf.fill(0); return store.add(k, v); } });
    const sig = await D.L.reserveAndSign(editing, D.kp, free, buf);
    expect(lmsVerify(kp.publicKey, other, sig)).toBe(free);
    expect(await editing.get(id, free)).toMatchObject({ messageHash: toHex(sha256(other)), message: toHex(other) });

    // A signature this process only read back from a ledger (another device's, imported) arms the guard as well.
    const E = await otherDevice();
    const withA = E.L.createMemoryLeafLedger();
    const fromD = D.L.createMemoryLeafLedger();
    await D.L.reserveAndSign(fromD, D.kp, leaf, m1);
    await E.L.importLeafRecords(withA, E.kp.publicKey, await D.L.exportLeafRecords(fromD, id));
    expect(toHex(await E.L.reserveAndSign(withA, E.kp, leaf, m1))).toBe(toHex(sigA)); // returned as recorded
    await expect(E.L.reserveAndSign(E.L.createMemoryLeafLedger(), E.kp, leaf, m2)).rejects.toThrow(/already signed a different message in this process/);
  });

  it("the same message on both devices is completed with its signature, never re-signed differently; a landing claim is not imported (read from the chain again)", async () => {
    const deviceA = createMemoryLeafLedger();
    await reserveAndSign(deviceA, kp, 1023, message);
    await deviceA.markLanded(id, 1023, { slot: 77n, attested: true });
    const deviceB = createMemoryLeafLedger();
    expect(await deviceB.reserve(id, 1023, sha256(message))).toBe("reserved");
    expect(await importLeafRecords(deviceB, kp.publicKey, await exportLeafRecords(deviceA, id))).toMatchObject({ merged: 1, conflicts: [] });
    // Audit 4, ID-F4: an export's "landed" is not authenticated (only its signature is): the record comes in signed.
    expect(await deviceB.get(id, 1023)).toMatchObject({ status: "signed", signature: sigAt(1023), landedSlot: null, attested: null });
    // A device that saw the landing itself keeps it.
    expect(await importLeafRecords(deviceA, kp.publicKey, await exportLeafRecords(deviceB, id))).toMatchObject({ unchanged: 1 });
    expect(await deviceA.get(id, 1023)).toMatchObject({ status: "landed", landedSlot: "77", attested: true });
  });

  it("audit 4, ID-F3 / ID-F2b: a record without a signature only marks its leaf taken (burned, no message), and never re-points a message that holds a live leaf", async () => {
    // Device A signed `message` at its probe leaf; a tampered "other device" export holds one unsigned record that names
    // A's message at another leaf (PoC poc_identity_steer, test 2).
    const A = await otherDevice();
    const deviceA = A.L.createMemoryLeafLedger();
    const signed = await A.L.signAtNextLeaf(deviceA, A.kp, message, empty());
    const target = (signed.leaf + 300) % 1024;
    const forged: LeafLedgerExport = {
      format: LEAF_LEDGER_EXPORT_FORMAT,
      identityId: V.identity.identityId,
      records: [
        { identityId: V.identity.identityId, leaf: target, messageHash: toHex(sha256(message)), status: "reserved" as const, launch: null, message: null, signature: null, landedSlot: null, attested: null, createdAt: 0, updatedAt: 0 },
      ],
    };
    expect(await A.L.importLeafRecords(deviceA, A.kp.publicKey, forged)).toMatchObject({ added: 1 });
    // The leaf is taken, but holds no message.
    expect(await deviceA.get(id, target)).toMatchObject({ status: "burned", message: null, signature: null });
    expect(holdsMessageLeaf((await deviceA.get(id, target))!)).toBe(false);
    // The message still points at its own signed leaf: a rebuild gives the same leaf and the same bytes.
    expect(await deviceA.findByMessage(id, sha256(message))).toMatchObject({ leaf: signed.leaf, status: "signed" });
    const again = await A.L.signAtNextLeaf(deviceA, A.kp, message, empty());
    expect([again.leaf, toHex(again.signature)]).toEqual([signed.leaf, toHex(signed.signature)]);
    // An unsigned record for a leaf this ledger holds changes nothing there.
    const onA: LeafLedgerExport = { ...forged, records: [{ ...forged.records[0]!, leaf: signed.leaf, messageHash: toHex(sha256(other)) }] };
    expect(await A.L.importLeafRecords(deviceA, A.kp.publicKey, onA)).toMatchObject({ unchanged: 1, conflicts: [] });
    expect(await deviceA.get(id, signed.leaf)).toMatchObject({ status: "signed", messageHash: toHex(sha256(message)) });
    // A signed record of a message this ledger holds live at another leaf is added (taken), but the index stays on the live leaf.
    const C = await otherDevice();
    const deviceC = C.L.createMemoryLeafLedger();
    const elsewhere = (C.kp.leafProbeStart(other) + 7) % 1024;
    await C.L.reserveAndSign(deviceC, C.kp, elsewhere, other);
    const D = await otherDevice();
    const deviceD = D.L.createMemoryLeafLedger();
    const live = await D.L.signAtNextLeaf(deviceD, D.kp, other, empty());
    expect(live.leaf).not.toBe(elsewhere);
    expect(await D.L.importLeafRecords(deviceD, D.kp.publicKey, await C.L.exportLeafRecords(deviceC, id))).toMatchObject({ added: 1 });
    expect(await deviceD.get(id, elsewhere)).toMatchObject({ status: "signed" });
    expect(await deviceD.findByMessage(id, sha256(other))).toMatchObject({ leaf: live.leaf });
  });

  it("refuses an export it cannot authenticate, writing nothing", async () => {
    const deviceA = createMemoryLeafLedger();
    await reserveAndSign(deviceA, kp, 600, message);
    await deviceA.reserve(id, 601, sha256(other));
    const good = await exportLeafRecords(deviceA, id);
    const deviceB = createMemoryLeafLedger();
    const forged = { ...good, records: good.records.map((r) => (r.leaf === 600 ? { ...r, signature: sigAt(512) } : r)) };
    await expect(importLeafRecords(deviceB, kp.publicKey, forged)).rejects.toThrow(/does not verify at this leaf/);
    const swapped = { ...good, records: good.records.map((r) => (r.leaf === 600 ? { ...r, message: toHex(other) } : r)) };
    await expect(importLeafRecords(deviceB, kp.publicKey, swapped)).rejects.toThrow(/does not hash/);
    await expect(importLeafRecords(deviceB, kp.publicKey, { ...good, identityId: "00".repeat(32) })).rejects.toThrow(/another identity/);
    await expect(importLeafRecords(deviceB, kp.publicKey, { ...good, format: "v0" } as unknown as typeof good)).rejects.toThrow(/not a leaf-ledger export/);
    await expect(importLeafRecords(deviceB, kp.publicKey.subarray(1), good)).rejects.toThrow(/56-byte/);
    expect(await deviceB.leaves(id)).toEqual([]);
    expect((await importLeafRecords(deviceB, kp.publicKey, good)).added).toBe(2);
    expect(await deviceB.leaves(id)).toEqual([600, 601]);
  });
});

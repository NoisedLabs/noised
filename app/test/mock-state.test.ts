/**
 * The simulated chain's saved state (src/lib/mock/store.ts): state v6 holds
 * the tokens' on-chain metadata records and the PQ identities' accounts (the
 * leaf bitmap the app's attestations need); demo state saved by an earlier
 * protocol version (v4: attestations of a name, symbol and uri, no records;
 * v5: no identity accounts) is discarded and seeded again, never read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURES } from "../src/lib/mock/fixtures";

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
  vi.unstubAllGlobals();
});

/** The store as a fresh page load sees it (the chain module installs the seed). */
async function reload(): Promise<typeof import("../src/lib/mock/store")> {
  vi.resetModules();
  await import("../src/lib/mock/chain");
  return import("../src/lib/mock/store");
}

describe("demo chain state", () => {
  it("discards v4, v5 and v6 state and seeds v7, with one metadata record per demo token and no identity yet", async () => {
    stored.set("noised.demo-chain.v4", JSON.stringify({ version: 4, seededAt: 1 }));
    stored.set("noised.demo-chain.v5", JSON.stringify({ version: 5, seededAt: 2 }));
    stored.set("noised.demo-chain.v6", JSON.stringify({ version: 6, seededAt: 3 }));
    const s = (await reload()).state();
    expect(s.version).toBe(7);
    expect(stored.has("noised.demo-chain.v4")).toBe(false);
    expect(stored.has("noised.demo-chain.v5")).toBe(false);
    expect(stored.has("noised.demo-chain.v6")).toBe(false);
    expect(Object.keys(s.tokenMetas)).toHaveLength(FIXTURES.length);
    expect(s.identities).toEqual({});
    expect(JSON.parse(stored.get("noised.demo-chain.v7") ?? "null")).toMatchObject({ version: 7, seededAt: s.seededAt });
  });

  it("reads saved v7 state back, records and identities included, and never a v6-shaped state under the v7 key", async () => {
    const first = await reload();
    const s = first.state();
    s.seededAt = 12_345;
    s.identities["Identity1111111111111111111111111111111111"] = { publicKey: new Uint8Array(56).fill(7), used: new Uint8Array(128).fill(1) };
    first.persist();
    const again = (await reload()).state();
    expect(again.seededAt).toBe(12_345);
    expect(again.tokenMetas).toEqual(s.tokenMetas);
    expect(again.identities).toEqual(s.identities);
    stored.set("noised.demo-chain.v7", JSON.stringify({ version: 6, seededAt: 1 }));
    expect((await reload()).state().seededAt).not.toBe(1);
  });
});

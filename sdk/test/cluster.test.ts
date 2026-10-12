/**
 * `assertCluster`: every PQ signing entry point checks the endpoint's
 * genesis hash against the cluster its keys are for (audit round 2: a
 * mislabeled devnet run must never produce mainnet-valid signatures).
 */
import { describe, expect, it } from "vitest";

import type { Cluster } from "../src/constants.js";
import { assertCluster, ClusterMismatchError, clusterOfGenesisHash, GENESIS_HASHES } from "../src/rpc/cluster.js";
import { MockConnection } from "./helpers.js";

const LOCAL_HASH = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";
const TESTNET_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

function endpoint(hash: string | Error): MockConnection {
  const c = new MockConnection();
  if (hash instanceof Error) {
    c.getGenesisHash = async () => {
      throw hash;
    };
  } else c.genesisHash = hash;
  return c;
}

describe("assertCluster", () => {
  it("the public clusters' genesis hashes", () => {
    expect(GENESIS_HASHES).toEqual({ mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" });
    expect(Object.isFrozen(GENESIS_HASHES)).toBe(true);
    expect([clusterOfGenesisHash(GENESIS_HASHES.mainnet), clusterOfGenesisHash(GENESIS_HASHES.devnet), clusterOfGenesisHash(LOCAL_HASH)]).toEqual(["mainnet", "devnet", null]);
  });

  it("real devnet, by the hash it serves (`solana genesis-hash -u devnet`, 2026-10-10): devnet keys sign there, localnet keys never do (SDK 0.5.0 had a wrong devnet hash)", async () => {
    const REAL_DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    expect(clusterOfGenesisHash(REAL_DEVNET)).toBe("devnet");
    expect(await assertCluster(endpoint(REAL_DEVNET).asConnection(), "devnet")).toBe(REAL_DEVNET);
    // With the wrong hash, real devnet read as "a local cluster" and a localnet signer with allowLocalnet accepted it.
    await expect(assertCluster(endpoint(REAL_DEVNET).asConnection(), "localnet", { allowLocalnet: true })).rejects.toThrow(/keys for localnet, but the endpoint serves devnet/);
    await expect(assertCluster(endpoint(REAL_DEVNET).asConnection(), "mainnet")).rejects.toThrow(/keys for mainnet, but the endpoint serves devnet/);
  });

  it("accepts mainnet and devnet only on their own genesis hash, and returns it", async () => {
    expect(await assertCluster(endpoint(GENESIS_HASHES.mainnet).asConnection(), "mainnet")).toBe(GENESIS_HASHES.mainnet);
    expect(await assertCluster(endpoint(GENESIS_HASHES.devnet).asConnection(), "devnet")).toBe(GENESIS_HASHES.devnet);
    // allowLocalnet changes nothing for them.
    expect(await assertCluster(endpoint(GENESIS_HASHES.mainnet).asConnection(), "mainnet", { allowLocalnet: true })).toBe(GENESIS_HASHES.mainnet);
    const cases: [Cluster, string, RegExp][] = [
      ["mainnet", GENESIS_HASHES.devnet, /keys for mainnet, but the endpoint serves devnet/],
      ["devnet", GENESIS_HASHES.mainnet, /keys for devnet, but the endpoint serves mainnet/],
      ["mainnet", LOCAL_HASH, /keys for mainnet, but the endpoint serves another cluster/],
      ["devnet", TESTNET_HASH, /serves another cluster/],
    ];
    for (const [expected, hash, why] of cases) {
      const e = await assertCluster(endpoint(hash).asConnection(), expected, { allowLocalnet: true }).catch((x: unknown) => x);
      expect(e, `${expected} on ${hash}`).toBeInstanceOf(ClusterMismatchError);
      expect((e as Error).message).toMatch(why);
      expect((e as ClusterMismatchError).expected).toBe(expected);
      expect((e as ClusterMismatchError).genesisHash).toBe(hash);
      expect((e as ClusterMismatchError).actual).toBe(clusterOfGenesisHash(hash));
    }
  });

  it("localnet: only with allowLocalnet, and never on a mainnet or devnet endpoint", async () => {
    const local = endpoint(LOCAL_HASH);
    await expect(assertCluster(local.asConnection(), "localnet")).rejects.toThrow(/without allowLocalnet/);
    await expect(assertCluster(local.asConnection(), "localnet", { allowLocalnet: false })).rejects.toThrow(ClusterMismatchError);
    // Refused before asking the endpoint.
    expect(local.calls).toEqual([]);
    expect(await assertCluster(local.asConnection(), "localnet", { allowLocalnet: true })).toBe(LOCAL_HASH);
    expect(await assertCluster(endpoint(TESTNET_HASH).asConnection(), "localnet", { allowLocalnet: true })).toBe(TESTNET_HASH);
    for (const [hash, name] of [
      [GENESIS_HASHES.mainnet, "mainnet"],
      [GENESIS_HASHES.devnet, "devnet"],
    ] as const) {
      const e = await assertCluster(endpoint(hash).asConnection(), "localnet", { allowLocalnet: true }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ClusterMismatchError);
      expect((e as Error).message).toMatch(new RegExp(`keys for localnet, but the endpoint serves ${name} .*valid on ${name}`));
    }
  });

  it("a hash that cannot be read is a refusal; every call asks again", async () => {
    await expect(assertCluster(endpoint(new Error("connection refused")).asConnection(), "mainnet")).rejects.toThrow(/could not read the endpoint's genesis hash .*connection refused/);
    await expect(assertCluster(endpoint("").asConnection(), "devnet")).rejects.toThrow(/no genesis hash/);
    const odd = new MockConnection();
    odd.getGenesisHash = async () => 42 as unknown as string;
    await expect(assertCluster(odd.asConnection(), "mainnet")).rejects.toThrow(ClusterMismatchError);
    await expect(assertCluster(endpoint(GENESIS_HASHES.mainnet).asConnection(), "testnet" as Cluster)).rejects.toThrow(RangeError);
    const c = endpoint(GENESIS_HASHES.devnet);
    await assertCluster(c.asConnection(), "devnet");
    c.genesisHash = GENESIS_HASHES.mainnet; // the endpoint behind the same Connection changed
    await expect(assertCluster(c.asConnection(), "devnet")).rejects.toThrow(ClusterMismatchError);
    expect(c.calls.filter((x) => x === "getGenesisHash").length).toBe(2);
  });
});

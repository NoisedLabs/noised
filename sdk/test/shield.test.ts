/** Shield client: base-mint policy mirror, PDAs and wrap / unwrap builders. */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { concatBytes, toHex, u64le } from "../src/codec/bytes.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { associatedTokenAddress, extraAccountMetaListAddress, hookPolicyAddress, shieldAddresses } from "../src/pda.js";
import { getAccount } from "../src/rpc/fetch.js";
import { buildCreateShieldTx, buildUnwrapTx, buildWrapTx, fetchShield, shieldMintPolicy } from "../src/shield/index.js";
import { ext, key, MockConnection, mintBytes, SPL, T22 } from "./helpers.js";

function shieldData(baseMint: PublicKey, baseTokenProgram: PublicKey): Uint8Array {
  const a = shieldAddresses(baseMint, baseTokenProgram);
  const codec = idlCodecs().shield;
  return concatBytes([
    codec.accountDiscriminator("Shield"),
    codec.encodeType("Shield", { version: 1, bump: 255, authorityBump: 254, zMintBump: 253, decimals: 6, baseMint, baseTokenProgram, zMint: a.zMint, escrow: a.escrow, createdAt: 1n }),
  ]);
}

async function policy(owner: PublicKey, data: Uint8Array) {
  const c = new MockConnection().set(key("m"), { owner, data });
  return shieldMintPolicy(await getAccount(c.asConnection(), key("m")));
}

describe("create_shield base-mint policy (policy.rs allowlist, unknown types fail closed)", () => {
  it("accepts SPL mints and the four allowlisted extensions", async () => {
    expect((await policy(SPL, mintBytes({}))).eligible).toBe(true);
    const all = await policy(T22, mintBytes({ extensions: [ext.metadataPointer(null, key("m")), ext.transferHook(null, PROGRAM_IDS.hook), ext.transferFeeConfig(key("cfg"), null, 10)] }));
    expect(all).toMatchObject({ eligible: true, refusals: [] });
  });

  it("refuses everything else", async () => {
    for (const e of [ext.permanentDelegate(null), ext.mintCloseAuthority(key("c")), ext.pausable(null), ext.nonTransferable(), ext.defaultAccountState(1), ext.raw(4, new Uint8Array(65)), ext.raw(24, new Uint8Array(0)), ext.raw(25, new Uint8Array(0)), ext.raw(10, new Uint8Array(0)), ext.raw(20, new Uint8Array(64))]) {
      const r = await policy(T22, mintBytes({ extensions: [ext.metadataPointer(null, key("m")), e] }));
      expect(r.eligible, `type ${e.type}`).toBe(false);
    }
    expect((await policy(T22, mintBytes({ extensions: [ext.raw(28, new Uint8Array(4))] }))).refusals[0]).toMatch(/cannot accept/);
    expect((await policy(T22, mintBytes({ initialized: false }))).eligible).toBe(false);
  });
});

describe("shield builders", () => {
  const owner = key("shield/owner");

  it("create_shield: PDAs and the escrow ATA under the base mint's token program", async () => {
    for (const tp of [SPL, T22]) {
      const base = key(`shield/base-${tp.toBase58().slice(0, 4)}`);
      const c = new MockConnection().set(base, { owner: tp, data: tp.equals(SPL) ? mintBytes({}) : mintBytes({ extensions: [] }) });
      const tx = await buildCreateShieldTx(c.asConnection(), owner, base);
      const ix = tx.instructions.at(-1)!;
      const a = shieldAddresses(base, tp);
      expect(ix.keys.slice(0, 7).map((k) => k.pubkey.toBase58())).toEqual([owner, base, a.shield, a.authority, a.zMint, a.escrow, tp].map((k) => k.toBase58()));
      expect(a.escrow.equals(associatedTokenAddress(a.authority, base, tp))).toBe(true);
      c.set(a.shield, { owner: PROGRAM_IDS.shield, data: shieldData(base, tp) });
      await expect(buildCreateShieldTx(c.asConnection(), owner, base)).rejects.toThrow(/already has a shield/);
    }
    const bad = new MockConnection().set(key("bad"), { owner: T22, data: mintBytes({ extensions: [ext.permanentDelegate(key("d"))] }) });
    await expect(buildCreateShieldTx(bad.asConnection(), owner, key("bad"))).rejects.toThrow(/refuse/);
  });

  it("wrap / unwrap: accounts, amounts and the Launch Guard's hook accounts", async () => {
    const base = key("shield/hooked");
    const c = new MockConnection();
    c.set(base, { owner: T22, data: mintBytes({ extensions: [ext.metadataPointer(null, base), ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook)] }) });
    const a = shieldAddresses(base, T22);
    c.set(a.shield, { owner: PROGRAM_IDS.shield, data: shieldData(base, T22) });
    expect((await fetchShield(c.asConnection(), base))?.zMint.equals(a.zMint)).toBe(true);

    const wrap = await buildWrapTx(c.asConnection(), owner, base, 1_000n);
    const wix = wrap.instructions.at(-1)!;
    expect(wrap.instructions[0]!.programId.equals(KNOWN_ACCOUNTS.associatedToken)).toBe(true);
    expect(wix.keys.slice(0, 10).map((k) => k.pubkey.toBase58())).toEqual(
      [owner, a.shield, a.authority, base, a.zMint, a.escrow, associatedTokenAddress(owner, base, T22), associatedTokenAddress(owner, a.zMint, T22), T22, T22].map((k) => k.toBase58()),
    );
    expect(wix.keys[0]!.isSigner).toBe(true);
    // The Launch Guard's four hook accounts, in the launchpad's canonical order, read-only.
    expect(wix.keys.slice(10).map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      [extraAccountMetaListAddress(base), hookPolicyAddress(base), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook].map((k) => [k.toBase58(), false, false]),
    );
    expect(toHex(wix.data.subarray(8))).toBe(toHex(u64le(1_000n)));

    const unwrap = await buildUnwrapTx(c.asConnection(), owner, base, 5n);
    const uix = unwrap.instructions.at(-1)!;
    expect(uix.keys.slice(10).map((k) => k.pubkey.toBase58())).toEqual(wix.keys.slice(10).map((k) => k.pubkey.toBase58()));
    expect(toHex(uix.data.subarray(0, 8))).toBe(toHex(Uint8Array.from(idlCodecs().shield.instruction("unwrap").discriminator)));

    await expect(buildWrapTx(c.asConnection(), owner, key("shield/none"), 1n)).rejects.toThrow(/no shield/);
    await expect(buildWrapTx(c.asConnection(), owner, base, 0n)).rejects.toThrow(/positive/);
  });

  it("fetchShield refuses an account that does not match its derived addresses", async () => {
    const base = key("shield/mismatch");
    const c = new MockConnection();
    const codec = idlCodecs().shield;
    const a = shieldAddresses(base, SPL);
    c.set(a.shield, {
      owner: PROGRAM_IDS.shield,
      data: concatBytes([
        codec.accountDiscriminator("Shield"),
        codec.encodeType("Shield", { version: 1, bump: 255, authorityBump: 254, zMintBump: 253, decimals: 6, baseMint: base, baseTokenProgram: SPL, zMint: key("fake-z"), escrow: a.escrow, createdAt: 1n }),
      ]),
    });
    await expect(fetchShield(c.asConnection(), base)).rejects.toThrow(/derived addresses/);
  });
});

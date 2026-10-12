/**
 * Borsh layouts and the IDL-driven codec:
 * - LaunchParams bytes laid out by hand exactly as the Rust test
 *   `launch_params_borsh_layout_is_stable` describes (they feed params_hash);
 * - round trips of every account and argument type;
 * - parity with Anchor's own TypeScript coder (@coral-xyz/anchor BorshCoder)
 *   on random values (our accounts) and random bytes (Meteora accounts);
 * - account sizes equal the programs' `InitSpace` / `const_assert_eq!` sizes;
 * - Meteora's zero-copy types are padding-free, so sequential decoding is exact.
 */
import { BorshCoder, type Idl as AnchorIdl } from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { BorshReader, BorshWriter } from "../src/codec/borsh.js";
import { concatBytes, toHex, u32le, u64le } from "../src/codec/bytes.js";
import { camelCase, IdlCodec, type EnumValue, type IdlType } from "../src/codec/idl.js";
import { AUTHORIZATION, CERTIFICATE, HOOK_POLICY, LAUNCH_RULES } from "../src/constants.js";
import { IDLS, idlCodecs } from "../src/idl/index.js";
import { decodeCertificate, decodeLaunch } from "../src/launch/accounts.js";
import { deserializeLaunchParams, serializeLaunchParams } from "../src/launch/builders.js";
import { launchParamsHash } from "../src/launch/hash.js";
import type { LaunchParams } from "../src/types.js";

const key = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));

function goodParams(): LaunchParams {
  return {
    tokenDecimal: 6,
    sqrtStartPrice: 1n << 60n,
    curve: [
      { sqrtPrice: 1n << 62n, liquidity: 1n << 90n },
      { sqrtPrice: 1n << 63n, liquidity: 1n << 89n },
    ],
    migrationQuoteThreshold: 85_000_000_000n,
    baseFee: { cliffFeeNumerator: 500_000_000n, firstFactor: 10, secondFactor: 1n, thirdFactor: 49_000_000n, baseFeeMode: 0 },
    dynamicFee: null,
    migrationFeeOption: 2,
    openDelaySecs: 30,
    guardSecs: 3_600,
    maxWalletBps: 100,
    maxBuyBps: 50,
    p2pLocked: false,
    batchWalletCap: 0n,
    batchTotalCap: 0n,
    recipients: [
      { wallet: key(7), bps: 7_000 },
      { wallet: key(8), bps: 3_000 },
    ],
    pqIdentity: Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i),
  };
}

const u128le = (v: bigint): Uint8Array => concatBytes([u64le(v & ((1n << 64n) - 1n)), u64le(v >> 64n)]);
const u16le = (v: number): Uint8Array => Uint8Array.of(v & 0xff, v >> 8);

describe("LaunchParams (params_hash input)", () => {
  it("serializes field by field like the Rust layout test", () => {
    const p = goodParams();
    const expected = concatBytes([
      Uint8Array.of(p.tokenDecimal),
      u128le(p.sqrtStartPrice),
      u32le(p.curve.length),
      ...p.curve.flatMap((c) => [u128le(c.sqrtPrice), u128le(c.liquidity)]),
      u64le(p.migrationQuoteThreshold),
      u64le(p.baseFee.cliffFeeNumerator),
      u16le(p.baseFee.firstFactor),
      u64le(p.baseFee.secondFactor),
      u64le(p.baseFee.thirdFactor),
      Uint8Array.of(p.baseFee.baseFeeMode),
      Uint8Array.of(0), // dynamic_fee: None
      Uint8Array.of(p.migrationFeeOption),
      u32le(p.openDelaySecs),
      u32le(p.guardSecs),
      u16le(p.maxWalletBps),
      u16le(p.maxBuyBps),
      Uint8Array.of(p.p2pLocked ? 1 : 0),
      u64le(p.batchWalletCap),
      u64le(p.batchTotalCap),
      u32le(p.recipients.length),
      ...p.recipients.flatMap((r) => [r.wallet.toBytes(), u16le(r.bps)]),
      p.pqIdentity, // pq_identity: [u8; 32], appended last (PQ v2)
    ]);
    const bytes = serializeLaunchParams(p);
    expect(toHex(bytes)).toBe(toHex(expected));
    expect(launchParamsHash(p)).toEqual(sha256(expected));
    const back = deserializeLaunchParams(bytes);
    expect(back).toEqual(p);
  });

  it("encodes Some(dynamic fee) with every field in order", () => {
    const p = goodParams();
    p.dynamicFee = { binStep: 1, binStepU128: 1_844_674_407_370_955n, filterPeriod: 10, decayPeriod: 120, reductionFactor: 5_000, maxVolatilityAccumulator: 14_460_000, variableFeeControl: 956 };
    const bytes = serializeLaunchParams(p);
    const tail = concatBytes([
      Uint8Array.of(1),
      u16le(1),
      u128le(1_844_674_407_370_955n),
      u16le(10),
      u16le(120),
      u16le(5_000),
      u32le(14_460_000),
      u32le(956),
    ]);
    const start = 1 + 16 + 4 + 64 + 8 + 27;
    expect(toHex(bytes.subarray(start, start + tail.length))).toBe(toHex(tail));
    expect(deserializeLaunchParams(bytes)).toEqual(p);
  });

  it("the hash commits to every field", () => {
    const base = toHex(launchParamsHash(goodParams()));
    const changed = goodParams();
    changed.p2pLocked = true;
    expect(toHex(launchParamsHash(changed))).not.toBe(base);
    const shifted = goodParams();
    shifted.recipients[1]!.bps -= 1;
    shifted.recipients[0]!.bps += 1;
    expect(toHex(launchParamsHash(shifted))).not.toBe(base);
    const identity = goodParams();
    identity.pqIdentity = Uint8Array.from(identity.pqIdentity).fill(0xa1, 31);
    expect(toHex(launchParamsHash(identity))).not.toBe(base);
  });

  it("rejects out-of-range values instead of truncating them", () => {
    const p = goodParams();
    p.tokenDecimal = 256;
    expect(() => serializeLaunchParams(p)).toThrow();
    const q = goodParams();
    q.batchWalletCap = 1n << 64n;
    expect(() => serializeLaunchParams(q)).toThrow();
    const r = goodParams();
    r.curve[0]!.liquidity = -1n;
    expect(() => serializeLaunchParams(r)).toThrow();
    const t = goodParams();
    t.pqIdentity = new Uint8Array(31);
    expect(() => serializeLaunchParams(t)).toThrow();
  });
});

describe("borsh reader strictness", () => {
  it("refuses non-canonical bools, option tags and truncated data", () => {
    expect(() => new BorshReader(Uint8Array.of(2)).bool()).toThrow(/bool/);
    expect(() => new BorshReader(Uint8Array.of(2)).optionTag()).toThrow(/option/);
    expect(() => new BorshReader(Uint8Array.of(1, 2, 3)).u32()).toThrow(/end of data/);
    expect(() => new BorshReader(concatBytes([u32le(5), Uint8Array.of(1, 2)])).bytes()).toThrow(/end of data/);
    expect(() => new BorshReader(concatBytes([u32le(1), Uint8Array.of(0xff)])).string()).toThrow(/UTF-8/);
  });

  it("round-trips the integer edges", () => {
    const w = new BorshWriter().u8(255).u16(65535).u32(0xffff_ffff).u64((1n << 64n) - 1n).u128((1n << 128n) - 1n).i64(-(1n << 63n)).i128(-1n);
    const r = new BorshReader(w.toBytes());
    expect([r.u8(), r.u16(), r.u32(), r.u64(), r.u128(), r.i64(), r.i128()]).toEqual([255, 65535, 0xffff_ffff, (1n << 64n) - 1n, (1n << 128n) - 1n, -(1n << 63n), -1n]);
    expect(r.remaining).toBe(0);
    expect(() => new BorshWriter().u64(-1n)).toThrow();
    expect(() => new BorshWriter().u8(1.5)).toThrow();
  });
});

describe("account sizes equal the programs' InitSpace / const_assert sizes", () => {
  it("Noised accounts (8-byte discriminator + InitSpace, computed by hand)", () => {
    const c = idlCodecs();
    // PQ v2: Launch + pq_identity; Commit + token_owner, refund_owner; Certificate + pq_identity, pq_leaf, attested_slot.
    expect(c.launchpad.accountSize("Launch")).toBe(8 + 545 + 32);
    expect(c.launchpad.accountSize("Launch")).toBe(585);
    expect(c.launchpad.accountSize("Commit")).toBe(8 + 75 + 32 + 32);
    // On-chain metadata: Certificate + metadata (the TokenMeta address), 487 bytes; P1c: + rules_hash, 519 bytes (CERTIFICATE.ACCOUNT_LEN).
    expect(c.launchpad.accountSize("Certificate")).toBe(8 + 405 + 32 + 2 + 8 + 32 + 32);
    expect(c.launchpad.accountSize("Certificate")).toBe(CERTIFICATE.ACCOUNT_LEN);
    expect(c.launchpad.accountSize("Protocol")).toBe(8 + 36);
    // Identity: version, bump, public_key[56], used[128], used_count u16; PayoutVault: version, bump, launch, vault, committed.
    expect(c.launchpad.accountSize("Identity")).toBe(8 + 1 + 1 + 56 + 128 + 2);
    expect(c.launchpad.accountSize("PayoutVault")).toBe(8 + 1 + 1 + 32 + 32 + 8);
    // Vault v4: version, bump, mint, genesis_key_id, sequence, key_id, key_ident, key_q, key_k, reserved.
    expect(c.vault.accountSize("Vault")).toBe(8 + 1 + 1 + 32 + 32 + 8 + 32 + 16 + 4 + 32 + 8);
    expect(c.vault.accountSize("Vault")).toBe(174);
    // Payout: version, bump, vault, sequence, destination_owner, amount, rent_payer.
    expect(c.vault.accountSize("Payout")).toBe(8 + 1 + 1 + 32 + 8 + 32 + 8 + 32);
    expect(c.vault.accountSize("Payout")).toBe(122);
    expect(c.shield.accountSize("Shield")).toBe(8 + 141);
    // HookPolicy v2 (P1c) ends with the rules (u32 length + bytes): variable size, 279 + len (HOOK_POLICY.BASE_LEN).
    expect(() => c.hook.accountSize("HookPolicy")).toThrow(/variable size/);
    const fixed = (c.hook.typeDef("HookPolicy").type as unknown as { fields: { name: string; type: never }[] }).fields.slice(0, -1);
    expect(8 + fixed.reduce((n, f) => n + c.hook.fixedSize(f.type)!, 0) + 4).toBe(HOOK_POLICY.BASE_LEN);
    // LaunchRules: 78 + len; Authorization: 2,669 with its 2,508-byte signature.
    const lr = (c.launchpad.typeDef("LaunchRules").type as unknown as { fields: { name: string; type: never }[] }).fields.slice(0, -1);
    expect(8 + lr.reduce((n, f) => n + c.launchpad.fixedSize(f.type)!, 0) + 4).toBe(LAUNCH_RULES.FIXED_LEN);
    const au = (c.launchpad.typeDef("Authorization").type as unknown as { fields: { name: string; type: never }[] }).fields.slice(0, -1);
    expect(8 + au.reduce((n, f) => n + c.launchpad.fixedSize(f.type)!, 0) + 4 + 2_508).toBe(AUTHORIZATION.ACCOUNT_LEN);
  });

  it("Meteora zero-copy accounts (const_assert_eq! in their sources)", () => {
    const c = idlCodecs();
    expect(c.dbc.fixedSize({ defined: { name: "PoolConfig" } })).toBe(1040);
    expect(c.dbc.fixedSize({ defined: { name: "ConfigWithTransferHook" } })).toBe(1120);
    expect(c.dbc.fixedSize({ defined: { name: "PoolState" } })).toBe(416);
    expect(c.dbc.fixedSize({ defined: { name: "TransferHookPool" } })).toBe(416);
    expect(c.dammV2.fixedSize({ defined: { name: "Pool" } })).toBe(1104);
    expect(c.dammV2.fixedSize({ defined: { name: "Position" } })).toBe(400);
    expect(c.dammV2.accountSize("Operator")).toBe(8 + 64);
  });

  it("Meteora zero-copy types have no implicit C padding (sequential decode is exact)", () => {
    expect(idlCodecs().dbc.bytemuckLayoutProblems()).toEqual([]);
    expect(idlCodecs().dammV2.bytemuckLayoutProblems()).toEqual([]);
  });
});

// ------------------------------------------------- parity with Anchor TS ---

/** Canonical JSON for comparing our decoded values with Anchor's. */
function canon(v: unknown, path = ""): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) {
    // Anchor decodes [u8; N] as number[]; ours are Uint8Array. No IDL here has arrays of other small ints.
    if (v.length > 0 && v.every((x) => typeof x === "number")) return toHex(Uint8Array.from(v as number[]));
    return v.map((x, i) => canon(x, `${path}[${i}]`));
  }
  if (typeof v === "object" && v !== null) {
    if (typeof (v as { toArrayLike?: unknown }).toArrayLike === "function") return (v as { toString(): string }).toString();
    const o = v as Record<string, unknown>;
    if ("kind" in o && typeof o["kind"] === "string" && Object.keys(o).every((k) => k === "kind" || k === "fields")) {
      return { enum: (o["kind"] as string).toLowerCase() };
    }
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o[keys[0]!] === "object" && o[keys[0]!] !== null && Object.keys(o[keys[0]!] as object).length === 0 && /^[A-Za-z]+$/.test(keys[0]!) && path.endsWith("status")) {
      return { enum: keys[0]!.toLowerCase() };
    }
    const out: Record<string, unknown> = {};
    for (const k of keys.sort()) out[camelCase(k)] = canon(o[k], camelCase(k));
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return v;
}

/** Deterministic random values of an IDL type (valid bools/enums/options). */
function randomValue(codec: IdlCodec, type: IdlType, rnd: () => number): unknown {
  const bigint = (bytes: number): bigint => {
    let v = 0n;
    for (let i = 0; i < bytes; i++) v = (v << 8n) | BigInt(Math.floor(rnd() * 256));
    return v;
  };
  if (typeof type === "string") {
    switch (type) {
      case "bool":
        return rnd() < 0.5;
      case "u8":
        return Math.floor(rnd() * 256);
      case "u16":
        return Math.floor(rnd() * 65_536);
      case "u32":
        return Math.floor(rnd() * 2 ** 32);
      case "u64":
        return bigint(8);
      case "i64":
        return bigint(8) - (1n << 63n);
      case "u128":
        return bigint(16);
      case "pubkey":
        return new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(rnd() * 256)));
      case "bytes":
        return Uint8Array.from({ length: Math.floor(rnd() * 40) }, () => Math.floor(rnd() * 256));
      case "string":
        return "noised-" + Math.floor(rnd() * 1e6).toString(36);
      default:
        throw new Error(`no generator for ${type}`);
    }
  }
  if ("option" in type) return rnd() < 0.5 ? null : randomValue(codec, type.option, rnd);
  if ("vec" in type) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(codec, type.vec, rnd));
  if ("array" in type) {
    const [inner, len] = type.array as [IdlType, number];
    if (inner === "u8") return Uint8Array.from({ length: len }, () => Math.floor(rnd() * 256));
    return Array.from({ length: len }, () => randomValue(codec, inner, rnd));
  }
  if ("defined" in type) {
    const def = codec.typeDef(type.defined.name);
    if (def.type.kind === "struct") {
      const out: Record<string, unknown> = {};
      for (const f of (def.type.fields ?? []) as { name: string; type: IdlType }[]) out[camelCase(f.name)] = randomValue(codec, f.type, rnd);
      return out;
    }
    if (def.type.kind === "enum") {
      const v = def.type.variants[Math.floor(rnd() * def.type.variants.length)]!;
      return { kind: v.name } satisfies EnumValue;
    }
  }
  throw new Error("unsupported type in generator");
}

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("parity with @coral-xyz/anchor's BorshCoder", () => {
  const ours: [keyof typeof IDLS, string[]][] = [
    ["launchpad", ["Launch", "Commit", "Certificate", "Protocol", "Identity", "PayoutVault"]],
    ["vault", ["Vault", "Payout"]],
    ["shield", ["Shield"]],
  ];
  for (const [idlName, accounts] of ours) {
    for (const account of accounts) {
      it(`${idlName}.${account}: random values encode/decode identically`, () => {
        const codec = idlCodecs()[idlName];
        const anchor = new BorshCoder(IDLS[idlName] as unknown as AnchorIdl);
        const rnd = lcg(account.length * 7919);
        for (let i = 0; i < 25; i++) {
          const value = randomValue(codec, { defined: { name: account } }, rnd);
          const data = concatBytes([codec.accountDiscriminator(account), codec.encodeType(account, value)]);
          expect(data.length).toBe(codec.accountSize(account));
          const mine = codec.decodeAccount(account, data);
          expect(canon(mine)).toEqual(canon(value));
          const theirs = anchor.accounts.decode(account, Buffer.from(data));
          expect(canon(theirs, "")).toEqual(canon(mine, ""));
        }
      });
    }
  }

  // Variable-size accounts (P1c: HookPolicy.rules, LaunchRules.bytes, Authorization.signature).
  for (const [idlName, account] of [
    ["hook", "HookPolicy"],
    ["launchpad", "LaunchRules"],
    ["launchpad", "Authorization"],
  ] as const) {
    it(`${idlName}.${account} (variable size): random values encode/decode identically`, () => {
      const codec = idlCodecs()[idlName];
      const anchor = new BorshCoder(IDLS[idlName] as unknown as AnchorIdl);
      const rnd = lcg(account.length * 104_729);
      for (let i = 0; i < 25; i++) {
        const value = randomValue(codec, { defined: { name: account } }, rnd);
        const data = concatBytes([codec.accountDiscriminator(account), codec.encodeType(account, value)]);
        const mine = codec.decodeAccount(account, data);
        expect(canon(mine)).toEqual(canon(value));
        expect(canon(anchor.accounts.decode(account, Buffer.from(data)), "")).toEqual(canon(mine, ""));
      }
    });
  }

  it("launchpad.Attestation (variable-size signature): random values encode/decode identically", () => {
    const codec = idlCodecs().launchpad;
    const anchor = new BorshCoder(IDLS.launchpad as unknown as AnchorIdl);
    const rnd = lcg(2708);
    for (let i = 0; i < 25; i++) {
      const value = randomValue(codec, { defined: { name: "Attestation" } }, rnd);
      const data = concatBytes([codec.accountDiscriminator("Attestation"), codec.encodeType("Attestation", value)]);
      const mine = codec.decodeAccount("Attestation", data);
      expect(canon(mine)).toEqual(canon(value));
      expect(canon(anchor.accounts.decode("Attestation", Buffer.from(data)), "")).toEqual(canon(mine, ""));
    }
  });

  const meteora: [keyof typeof IDLS, string][] = [
    ["dbc", "ConfigWithTransferHook"],
    ["dbc", "TransferHookPool"],
    ["dammV2", "Pool"],
    ["dammV2", "Position"],
    ["dammV2", "Operator"],
  ];
  for (const [idlName, account] of meteora) {
    it(`${idlName}.${account}: random bytes decode identically`, () => {
      const codec = idlCodecs()[idlName];
      const anchor = new BorshCoder(IDLS[idlName] as unknown as AnchorIdl);
      const rnd = lcg(account.length * 104729);
      for (let i = 0; i < 10; i++) {
        const body = Uint8Array.from({ length: codec.accountSize(account) - 8 }, () => Math.floor(rnd() * 256));
        const data = concatBytes([codec.accountDiscriminator(account), body]);
        const mine = codec.decodeAccount(account, data);
        const theirs = anchor.accounts.decode(account, Buffer.from(data));
        expect(canon(theirs, "")).toEqual(canon(mine, ""));
        // Re-encoding reproduces the bytes exactly.
        expect(toHex(codec.encodeType(account, mine))).toBe(toHex(body));
      }
    });
  }

  it("instruction data matches Anchor's instruction coder", () => {
    const codec = idlCodecs().launchpad;
    const anchor = new BorshCoder(IDLS.launchpad as unknown as AnchorIdl);
    const data = codec.encodeInstruction("commit", { amount: 123_456_789n });
    const decoded = anchor.instruction.decode(Buffer.from(data));
    expect(decoded?.name).toBe("commit");
    expect((decoded?.data as { amount: { toString(): string } }).amount.toString()).toBe("123456789");
    const claim = codec.encodeInstruction("claim", { owner: key(3) });
    expect((anchor.instruction.decode(Buffer.from(claim))?.data as { owner: PublicKey }).owner.equals(key(3))).toBe(true);
    // attest_launch: the record's hash (32 bytes) after the signature, then the rules hash (P1c), then the window.
    const attest = codec.encodeInstruction("attest_launch", {
      lmsPk: new Uint8Array(56).fill(1),
      lmsSig: new Uint8Array(2508).fill(2),
      metadataHash: new Uint8Array(32).fill(3),
      rulesHash: new Uint8Array(32).fill(4),
      notBefore: 1_767_225_600n,
      notAfter: -1n,
    });
    expect(attest.length).toBe(8 + 56 + 4 + 2508 + 32 + 32 + 8 + 8);
    const decoded2 = anchor.instruction.decode(Buffer.from(attest));
    expect(decoded2?.name).toBe("attest_launch");
    const args = decoded2?.data as Record<string, { toString(): string }>;
    expect((args["not_after"] ?? args["notAfter"])!.toString()).toBe("-1");
    expect(toHex(attest.subarray(8 + 56 + 4 + 2508, 8 + 56 + 4 + 2508 + 32))).toBe("03".repeat(32));
    // publish_metadata: the record's borsh (strings, flags between symbol and uri) after the discriminator.
    const publish = codec.encodeInstruction("publish_metadata", { name: "Name", symbol: "SYM", flags: 2, uri: "https://x", doc: "{}" });
    expect(toHex(publish)).toBe(toHex(concatBytes([Uint8Array.from([0xb3, 0xbf, 0xa8, 0x61, 0xc7, 0x19, 0xe5, 0x92]), u32le(4), new TextEncoder().encode("Name"), u32le(3), new TextEncoder().encode("SYM"), Uint8Array.of(2), u32le(9), new TextEncoder().encode("https://x"), u32le(2), new TextEncoder().encode("{}")])));
    expect(anchor.instruction.decode(Buffer.from(publish))?.name).toBe("publish_metadata");
  });

  it("refuses wrong discriminators and short data", () => {
    const codec = idlCodecs().launchpad;
    const commit = concatBytes([codec.accountDiscriminator("Commit"), new Uint8Array(75)]);
    expect(() => codec.decodeAccount("Launch", commit)).toThrow(/discriminator/);
    expect(() => decodeLaunch(key(1), concatBytes([codec.accountDiscriminator("Launch"), new Uint8Array(10)]))).toThrow(/end of data/);
    expect(() => decodeCertificate(key(1), commit)).toThrow(/discriminator/);
  });
});

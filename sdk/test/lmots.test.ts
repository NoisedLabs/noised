import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
// The raw signers live in the INTERNAL module (not exported from the package): tests and vectors import it directly.
import * as lmotsModule from "../src/pq/lmots.js";
import { candidatePublicKey, hmacSha256, publicKey, randomizer, RANDOMIZER_TAG, SIG_LEN, sign, signDeterministic, verify } from "../src/pq/lmots.js";
import * as lmsModule from "../src/pq/lms.js";
import * as sdk from "../src/index.js";

/** RFC 8554 Appendix F, Test Case 2, top-level tree (LMOTS_SHA256_N32_W4). */
const tc2 = JSON.parse(readFileSync(new URL("./vectors/rfc8554_tc2.json", import.meta.url), "utf8")) as {
  lms_height: number;
  seed: string;
  i: string;
  root: string;
  q: number;
  message: string;
  c: string;
  y: string[];
  path: string[];
};

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};
const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
};

const id = hex(tc2.i);
const msg = hex(tc2.message);
const sig = cat(hex(tc2.c), ...tc2.y.map(hex));

/** RFC 8554 Algorithm 6a: LMS root from an OTS public key and its path. */
function rootFromPath(kc: Uint8Array): string {
  let node = (1 << tc2.lms_height) + tc2.q;
  let tmp = sha256(cat(id, u32(node), Uint8Array.of(0x82, 0x82), kc));
  for (const p of tc2.path.map(hex)) {
    const parent = Math.floor(node / 2);
    tmp = node % 2 === 1
      ? sha256(cat(id, u32(parent), Uint8Array.of(0x83, 0x83), p, tmp))
      : sha256(cat(id, u32(parent), Uint8Array.of(0x83, 0x83), tmp, p));
    node = parent;
  }
  return toHex(tmp);
}

describe("LM-OTS (RFC 8554 Test Case 2)", () => {
  it("published signature verifies to the published LMS root", () => {
    expect(sig.length).toBe(SIG_LEN);
    const kc = candidatePublicKey(id, tc2.q, msg, sig)!;
    expect(rootFromPath(kc)).toBe(tc2.root);
  });

  it("key generation and signing reproduce the published signature", () => {
    const sk = { id, q: tc2.q, seed: hex(tc2.seed) };
    const pk = publicKey(sk);
    expect(toHex(pk.k)).toBe(toHex(candidatePublicKey(id, tc2.q, msg, sig)!));
    expect(toHex(sign(sk, msg, hex(tc2.c)))).toBe(toHex(sig));
    expect(verify(pk, msg, sig)).toBe(true);
  });

  it("rejects tampering and wrong lengths", () => {
    const sk = { id, q: tc2.q, seed: hex(tc2.seed) };
    const pk = publicKey(sk);
    for (const pos of [0, 31, 32, 1000, SIG_LEN - 1]) {
      const bad = Uint8Array.from(sig);
      bad[pos]! ^= 1;
      expect(verify(pk, msg, bad)).toBe(false);
    }
    expect(verify(pk, msg.subarray(1), sig)).toBe(false);
    expect(verify(pk, msg, sig.subarray(1))).toBe(false);
    expect(verify({ ...pk, q: pk.q + 1 }, msg, sig)).toBe(false);
  });

  it("two randomizers give two distinct valid signatures (why C must be deterministic)", () => {
    const sk = { id, q: 7, seed: hex(tc2.seed) };
    const pk = publicKey(sk);
    const a = sign(sk, msg, new Uint8Array(32).fill(1));
    const b = sign(sk, msg, new Uint8Array(32).fill(2));
    expect(toHex(a)).not.toBe(toHex(b));
    expect(verify(pk, msg, a) && verify(pk, msg, b)).toBe(true);
    expect(() => sign(sk, msg, new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("deterministic randomizer (noised_lmots::PrivateKey::randomizer / sign_deterministic)", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("HMAC-SHA256 matches RFC 4231 Test Case 2", () => {
    expect(toHex(hmacSha256(enc("Jefe"), [enc("what do ya "), enc("want for nothing?")]))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(toHex(hmacSha256(enc("Jefe"), [enc("what do ya want for nothing?")]))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("C = HMAC-SHA256(SEED, tag || I || u32be(q) || msg): the cross-language vector of crates/noised-lmots", () => {
    expect(new TextDecoder().decode(RANDOMIZER_TAG)).toBe("phalanx/pq/lmots/C");
    const sk = { id: new Uint8Array(16).fill(0x22), q: 7, seed: new Uint8Array(32).fill(0x11) };
    expect(toHex(randomizer(sk, enc("phalanx")))).toBe("efff9f338802ed72a95c53d848647c110c67a6a943e9aeecf572bd978e9d79d3");
    // The same construction spelled out.
    expect(toHex(randomizer(sk, enc("phalanx")))).toBe(toHex(hmacSha256(sk.seed, [RANDOMIZER_TAG, sk.id, u32(7), enc("phalanx")])));
  });

  it("signing the same message twice yields the identical signature; C differs per message", () => {
    const sk = { id, q: 7, seed: hex(tc2.seed) };
    const pk = publicKey(sk);
    const a = signDeterministic(sk, enc("pay carol 7"));
    const b = signDeterministic(sk, enc("pay carol 7"));
    expect(toHex(a)).toBe(toHex(b));
    expect(verify(pk, enc("pay carol 7"), a)).toBe(true);
    const c = signDeterministic(sk, enc("pay carol 8"));
    expect(toHex(c.subarray(0, 32))).not.toBe(toHex(a.subarray(0, 32)));
    expect(toHex(a.subarray(0, 32))).toBe(toHex(randomizer(sk, enc("pay carol 7"))));
    // C is keyed: another seed gives another C for the same message.
    expect(toHex(randomizer({ ...sk, seed: new Uint8Array(32).fill(5) }, enc("pay carol 7")))).not.toBe(toHex(a.subarray(0, 32)));
  });
});

describe("no public raw one-time signer (SDK v2 follow-up: lmots.sign / signDeterministic are internal)", () => {
  it("the package's lmots namespace is ./lmots.ts minus sign and signDeterministic, nothing else", () => {
    const internal = ["sign", "signDeterministic"];
    expect(Object.keys(sdk.lmots).sort()).toEqual(Object.keys(lmotsModule).filter((k) => !internal.includes(k)).sort());
    for (const k of internal) expect(k in sdk.lmots, k).toBe(false);
    // Verification and key ids stay public (the app checks signatures and derives vault addresses with them).
    expect([typeof sdk.lmots.verify, typeof sdk.lmots.keyId, typeof sdk.lmots.publicKey]).toEqual(["function", "function", "function"]);
  });

  it("no value reachable from the package root is a raw LM-OTS or LMS signer, and every exported signer is a guarded one", () => {
    const raw = new Map<unknown, string>([
      [lmotsModule.sign, "lmots.sign"],
      [lmotsModule.signDeterministic, "lmots.signDeterministic"],
      [lmsModule.signLeafDeterministic, "lms.signLeafDeterministic"],
      [lmsModule.signLeafWithRandomizer, "lms.signLeafWithRandomizer"],
    ]);
    const seen = new Set<unknown>();
    const reached: string[] = [];
    const signerNames: string[] = [];
    // Exported namespaces, functions, classes (statics and prototypes) and constant objects, a few levels deep;
    // getters are never invoked.
    const walk = (v: unknown, path: string, depth: number): void => {
      if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v) || depth > 3) return;
      seen.add(v);
      if (raw.has(v)) reached.push(`${path} = ${raw.get(v)}`);
      // A module namespace's bindings are read as values (they may be accessors in the test runner's transform).
      const namespace = Object.prototype.toString.call(v) === "[object Module]";
      for (const k of Object.getOwnPropertyNames(v)) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (d === undefined || (!namespace && !("value" in d))) continue;
        const value: unknown = namespace ? (v as Record<string, unknown>)[k] : d.value;
        if (typeof value === "function" && /^sign|Sign(?!ature)/.test(k) && depth <= 1) signerNames.push(`${path}.${k}`);
        walk(value, `${path}.${k}`, depth + 1);
      }
    };
    walk(sdk, "sdk", 0);
    expect(reached).toEqual([]);
    // What is left: Ed25519 helpers, verification, and the signers that take a durable ledger.
    expect(signerNames.sort()).toEqual(
      [
        "sdk.leafLedger.reserveAndSign", // LMS leaf, behind the leaf ledger
        "sdk.leafLedger.signAtNextLeaf", // LMS leaf, behind the leaf ledger
        "sdk.signAttestTransaction", // Ed25519 fee payer over an already signed attestation
        "sdk.signV1Message", // Ed25519
        "sdk.signWithdrawal", // LM-OTS vault key, behind the vault-key ledger and the recipient confirmation
        "sdk.signingLockName", // not a signer: the name of a launch's signing lock (audit 4, ID-F4)
      ].sort(),
    );
  });
});

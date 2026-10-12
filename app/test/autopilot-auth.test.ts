/**
 * What the creator's quantum key signs for an Autopilot change
 * (lib/programmable.ts), byte for byte the autopilot program's
 * (programs/noised-autopilot src/launchpad.rs):
 *   - the activation hashes equal vectors printed by the program's own
 *     activation_payload; the freeze payload is v2 (review 4 R5:
 *     SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph_hash || i64le not_after),
 *     the program's freeze_payload, read from its source); the vectors' freeze
 *     hashes predate it and are replayed as v1, which v2 never equals;
 *   - the revocation is payload v3 (audit 4 A4-3: SHA256("PHX-OP-REVOKE-V3" ||
 *     autopilot || graph_hash || operator || active_auth)): it equals the
 *     authorization the launchpad landed in the integration vectors
 *     (sdk/test/vectors/programmable.json, from tests/integration
 *     programmable_vectors.rs, with that run's active_auth); the program's
 *     revoke_payload signature is read from its source; the app's older v2
 *     vectors are replayed only to show that v3 never equals them;
 *   - the domain tags are the program's;
 *   - a freeze approval is good for one hour and is refused, in plain words,
 *     once it can no longer land (FreezeExpired);
 *   - the 140-byte PHX-AUTH-V1 message is in the spec's order;
 *   - the start time is fixed when the review opens, with generous margins,
 *     and checked again before anything is signed (review U11).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { toHex } from "../src/lib/format";
import {
  activateAtProblem,
  activationPayload,
  AUTH_DOMAINS,
  AUTH_KIND,
  authMessage,
  AUTOPILOT_CONSTANTS,
  chooseActivateAt,
  FREEZE_EXPIRED_MESSAGE,
  FREEZE_VALID_SECS,
  freezeExpiryProblem,
  freezeNotAfter,
  freezePayload,
  revokePayload,
} from "../src/lib/programmable";

interface Vector {
  autopilot: string;
  graphHash: string;
  activateAt: number;
  operator: string;
  activation: string;
  freeze: string;
  revoke: string;
}
const vectors = (JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/autopilot-payload-vectors.json", import.meta.url)), "utf8")) as { cases: Vector[] }).cases;

/** The pq_authorize records the launchpad landed for an autopilot in the integration run (the SDK's vector file). */
interface LandedAuthorizations {
  autopilot: string;
  graphHash: string;
  operator: string;
  activeAuth: string;
  activateAt: number;
  freezeNotAfter: number;
  cases: { kind: number; name: string; payloadHash: string; address: string }[];
}
const landed = (JSON.parse(readFileSync(fileURLToPath(new URL("../../sdk/test/vectors/programmable.json", import.meta.url)), "utf8")) as { authorizations: LandedAuthorizations }).authorizations;
const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const i64le = (v: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
};
const utf8 = (t: string): Uint8Array => new TextEncoder().encode(t);

describe("the payloads are the program's", () => {
  it("activation, freeze and revocation hashes equal the program's own vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(3);
    for (const v of vectors) {
      const ap = new PublicKey(v.autopilot);
      const g = hex(v.graphHash);
      expect(toHex(activationPayload(ap, g, v.activateAt).hash)).toBe(v.activation);
      // The vectors predate freeze payload v2: their freeze is v1, which v2 never equals.
      expect(toHex(sha256(cat(utf8("PHX-GRAPH-FRZ-V1"), ap.toBytes(), g)))).toBe(v.freeze);
      for (const notAfter of [v.activateAt, 1_800_003_600, 0]) {
        const v2 = freezePayload(ap, g, notAfter);
        expect(toHex(v2.hash)).toBe(toHex(sha256(cat(utf8("PHX-GRAPH-FRZ-V2"), ap.toBytes(), g, i64le(notAfter)))));
        expect(toHex(v2.hash)).not.toBe(v.freeze);
      }
      // The vectors' revocation is v2 (it predates audit 4): v2 is exactly that, and v3 never equals it for any activation.
      const op = new PublicKey(v.operator);
      expect(toHex(sha256(cat(utf8("PHX-OP-REVOKE-V2"), ap.toBytes(), g, op.toBytes())))).toBe(v.revoke);
      for (const activeAuth of [ap, op, PublicKey.default, new PublicKey(landed.activeAuth)]) {
        const v3 = revokePayload(ap, g, op, activeAuth);
        expect(toHex(v3.hash)).toBe(toHex(sha256(cat(utf8("PHX-OP-REVOKE-V3"), ap.toBytes(), g, op.toBytes(), activeAuth.toBytes()))));
        expect(toHex(v3.hash)).not.toBe(v.revoke);
      }
    }
  });

  it("the revocation (payload v3) and the freeze equal what the launchpad landed in the integration run", () => {
    const ap = new PublicKey(landed.autopilot);
    const g = hex(landed.graphHash);
    const byKind = (k: number): string => landed.cases.find((c) => c.kind === k)?.payloadHash ?? "";
    expect(toHex(activationPayload(ap, g, landed.activateAt).hash)).toBe(byKind(1));
    expect(toHex(freezePayload(ap, g, landed.freezeNotAfter).hash)).toBe(byKind(2));
    const revoke = revokePayload(ap, g, new PublicKey(landed.operator), new PublicKey(landed.activeAuth));
    expect(toHex(revoke.hash)).toBe(byKind(3));
    // The activation in force is the kind-1 authorization the run landed: what the revocation names.
    expect(landed.cases.find((c) => c.kind === 1)?.address).toBe(landed.activeAuth);
    // Another activation (even of the same graph and operator) needs another revocation: it can't be replayed.
    expect(toHex(revokePayload(ap, g, new PublicKey(landed.operator), PublicKey.default).hash)).not.toBe(byKind(3));
  });

  it("the domain tags are the program's constants, read from its source", () => {
    const src = readFileSync(fileURLToPath(new URL("../../programs/noised-autopilot/src/launchpad.rs", import.meta.url)), "utf8");
    const tag = (name: string): string | undefined => new RegExp(`${name}: &\\[u8; 16\\] = b"([^"]+)"`).exec(src)?.[1];
    expect(tag("ACTIVATE_DOMAIN")).toBe(AUTH_DOMAINS.activate);
    expect(tag("FREEZE_DOMAIN")).toBe(AUTH_DOMAINS.freeze);
    expect(tag("REVOKE_DOMAIN")).toBe(AUTH_DOMAINS.revoke);
    expect(AUTH_DOMAINS.freeze).toBe("PHX-GRAPH-FRZ-V2");
    expect(AUTH_DOMAINS.revoke).toBe("PHX-OP-REVOKE-V3");
    // revoke_payload(autopilot, graph_hash, operator, active_auth): the domain, then those four in this order (audit 4, A4-3).
    expect(src).toMatch(
      /pub fn revoke_payload\(\s*autopilot: &Pubkey,\s*graph_hash: &\[u8; 32\],\s*operator: &Pubkey,\s*active_auth: &Pubkey,?\s*\)[\s\S]*?REVOKE_DOMAIN,\s*autopilot\.as_ref\(\),\s*graph_hash,\s*operator\.as_ref\(\),\s*active_auth\.as_ref\(\),/,
    );
    // freeze_payload(autopilot, graph_hash, not_after): the domain, the autopilot, the graph, then not_after (i64 LE).
    expect(src).toMatch(/pub fn freeze_payload\(autopilot: &Pubkey, graph_hash: &\[u8; 32\], not_after: i64\)[\s\S]*?FREEZE_DOMAIN,\s*autopilot\.as_ref\(\),\s*graph_hash,\s*&not_after\.to_le_bytes\(\),/);
    expect(src).toContain('"PHX-AUTH-V1" || program || launch || creator || kind || payload_hash');
    expect(src).toMatch(/GRAPH_ACTIVATE: u8 = 1;[\s\S]*GRAPH_FREEZE: u8 = 2;[\s\S]*OPERATOR_REVOKE: u8 = 3;/);
    expect(AUTH_KIND).toEqual({ GRAPH_ACTIVATE: 1, GRAPH_FREEZE: 2, OPERATOR_REVOKE: 3 });
  });

  it("each kind's payload lists the fields it hashes, in order", () => {
    const ap = new PublicKey(vectors[0]?.autopilot ?? "");
    const g = new Uint8Array(32).fill(0x52);
    expect(activationPayload(ap, g, 5).fields.map((f) => f.name)).toEqual(["tag", "autopilot", "graph_hash", "activate_at"]);
    expect(activationPayload(ap, g, 5).bytes.length).toBe(16 + 32 + 32 + 8);
    expect(freezePayload(ap, g, 7).fields.map((f) => f.name)).toEqual(["tag", "autopilot", "graph_hash", "not_after"]);
    expect(freezePayload(ap, g, 7).bytes.length).toBe(16 + 32 + 32 + 8);
    expect(revokePayload(ap, g, ap, ap).fields.map((f) => f.name)).toEqual(["tag", "autopilot", "graph_hash", "operator", "active_auth"]);
    expect(revokePayload(ap, g, ap, ap).bytes.length).toBe(16 + 32 + 32 + 32 + 32);
    expect(freezePayload(ap, g, 7).kind).toBe(2);
    expect(revokePayload(ap, g, ap, ap).kind).toBe(3);
  });
});

describe("a freeze approval expires (review 4, R5)", () => {
  it("is good for one hour from when the creator confirms", () => {
    expect(FREEZE_VALID_SECS).toBe(3_600);
    expect(freezeNotAfter(1_800_000_000)).toBe(1_800_003_600);
    expect(freezeNotAfter(1_800_000_000.7)).toBe(1_800_003_600);
  });

  it("is refused in plain words once it can no longer land, never with a code", () => {
    const notAfter = 1_800_003_600;
    expect(freezeExpiryProblem(notAfter, 1_800_000_000)).toBeNull();
    expect(freezeExpiryProblem(notAfter, notAfter - 60)).toBeNull();
    expect(freezeExpiryProblem(notAfter, notAfter - 59)).toMatch(/about to expire/);
    expect(freezeExpiryProblem(notAfter, notAfter + 1)).toBe(FREEZE_EXPIRED_MESSAGE);
    expect(FREEZE_EXPIRED_MESSAGE).toMatch(/^This freeze approval has expired/);
    expect(FREEZE_EXPIRED_MESSAGE).not.toMatch(/FreezeExpired|6040|not_after/);
  });
});

describe("the authorization message", () => {
  it("is 140 bytes in the spec's order", () => {
    const k = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
    const m = authMessage({ program: k(1), launch: k(2), creator: k(3), kind: 2, payloadHash: new Uint8Array(32).fill(4) });
    expect(m.bytes.length).toBe(140);
    expect(m.fields.map((f) => [f.name, f.size])).toEqual([
      ["tag", 11],
      ["program", 32],
      ["launch", 32],
      ["creator", 32],
      ["kind", 1],
      ["payload_hash", 32],
    ]);
    expect(new TextDecoder().decode(m.bytes.subarray(0, 11))).toBe("PHX-AUTH-V1");
    expect(m.bytes[11 + 96]).toBe(2);
    expect(() => authMessage({ program: k(1), launch: k(2), creator: k(3), kind: 1, payloadHash: new Uint8Array(31) })).toThrow(RangeError);
  });
});

describe("the start time (review U11)", () => {
  const now = 1_800_000_007;
  it("is fixed when the review opens: a first autopilot 5 minutes later (no waiting period), a change 72 h + 1 h later, on a whole minute", () => {
    const first = chooseActivateAt(now, false);
    const change = chooseActivateAt(now, true);
    expect(first % 60).toBe(0);
    expect(change % 60).toBe(0);
    expect(first - now).toBeGreaterThanOrEqual(5 * 60);
    expect(first - now).toBeLessThan(6 * 60);
    expect(change - now).toBeGreaterThanOrEqual(AUTOPILOT_CONSTANTS.updateTimelockSecs + 3600);
    // The same review gives the same time a second later (the message does not change under the reader).
    expect(chooseActivateAt(now + 1, false)).toBe(first);
  });

  it("is checked again before signing: a time the chain would refuse spends no one-time key", () => {
    const first = chooseActivateAt(now, false);
    expect(activateAtProblem(first, now + 60, false)).toBeNull();
    expect(activateAtProblem(first, first - 60, false)).toMatch(/about to pass/);
    const change = chooseActivateAt(now, true);
    expect(activateAtProblem(change, now + 1800, true)).toBeNull();
    expect(activateAtProblem(change, now + 3600, true)).toMatch(/less than 72 hours/);
  });
});

/**
 * Creator launch rules in the verifier (P1c): `checkPqOrigin` and
 * `verifyAttestation` on the Rust-produced attestation of
 * `vectors/programmable.json`, which signs the typical rules (message v3,
 * rules hash included), then `verifyLaunch` on the mocked launch of
 * ./world.ts with rules bound (`withRules`) and one mutation at a time: the
 * Launch Guard's rules not the record's, the certificate's rules hash not the
 * attested one, `RULES_BOUND` missing or extra, rules not valid for the
 * guard; the certificate checks tested with the mask (8,191 passes); a
 * version-3 certificate (487 bytes) and a launch without rules ("No launch
 * rules").
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { fromHex, toHex, u32le } from "../src/codec/bytes.js";
import { CERTIFICATE, PROGRAM_IDS } from "../src/constants.js";
import { decodeAttestation, decodeLaunch } from "../src/launch/accounts.js";
import { decodeTokenMeta, tokenUriBytes } from "../src/metadata/record.js";
import { attestationAddress, certificateAddress, launchRulesAddress } from "../src/pda.js";
import { attestationMessage } from "../src/pq/identity.js";
import { decodeRulesRaw, encodeRulesRaw, explainRules, rulesHash } from "../src/programmable/index.js";
import type { RawAccount } from "../src/rpc/fetch.js";
import type { CertificateAccount, LaunchAccount, VerificationReport } from "../src/types.js";
import { checkPqOrigin, verifyAttestation, type PqOriginInputs } from "../src/verify/pqOrigin.js";
import { verifyLaunch } from "../src/verify/verifyLaunch.js";
import { emulatedLaunchRulesBytes } from "./attest_world.js";
import { MockConnection } from "./helpers.js";
import { PROG, vectorIdentity, withPq, withRules, worldRulesAddress, type PqWorld } from "./verifyFixtures.js";
import { accountBytes, world as unattestedWorld, type World } from "./world.js";

const TYPICAL = fromHex(PROG.rules[0]!.bytes);
const LARGEST = fromHex(PROG.rules[1]!.bytes);
const ZERO_HEX = "0".repeat(64);

beforeAll(() => {
  vectorIdentity(); // LMS key generation, once
}, 120_000);

// ------------------------------------------------- programmable.json ---

const launchKey = new PublicKey(PROG.launch.address);
const raw = (address: PublicKey, data: Uint8Array, owner: PublicKey = PROGRAM_IDS.launchpad): RawAccount => ({ address, owner, lamports: 1, executable: false, data });
const attestationData = (): Uint8Array => fromHex(PROG.attestation.accountData);
const rulesKey = new PublicKey(PROG.rules[0]!.address);

/** Valid inputs: the vector launch, its identity's attestation of the typical rules, launched when the window opened. */
function inputs(): PqOriginInputs & { certificate: CertificateAccount; launch: LaunchAccount } {
  const launch = decodeLaunch(launchKey, fromHex(PROG.launch.data));
  const att = decodeAttestation(new PublicKey(PROG.attestation.address), attestationData());
  const tokenMetaKey = new PublicKey(PROG.launch.tokenMeta);
  const record = decodeTokenMeta(tokenMetaKey, fromHex(PROG.launch.tokenMetaData));
  const certificate = {
    launch: launchKey,
    paramsHash: launch.paramsHash,
    creator: launch.creator,
    pqIdentity: launch.pqIdentity,
    pqLeaf: att.leaf,
    attestedSlot: att.slot,
    launchedAt: BigInt(PROG.attestation.notBefore),
    metadata: tokenMetaKey,
    rulesHash: fromHex(PROG.attestation.rulesHash),
  } as CertificateAccount;
  return {
    certificate,
    launch,
    attestation: raw(new PublicKey(PROG.attestation.address), attestationData()),
    identity: raw(new PublicKey(PROG.identity.address), fromHex(PROG.identity.data)),
    tokenMeta: raw(tokenMetaKey, fromHex(PROG.launch.tokenMetaData)),
    metadata: { name: record.record.name, symbol: record.record.symbol, uri: tokenUriBytes(record.record), additional: u32le(0) },
    rules: raw(rulesKey, fromHex(PROG.rules[0]!.accountData)),
  };
}

function problemsOf(i: PqOriginInputs): string {
  const r = checkPqOrigin(i);
  expect(r.origin?.verified ?? false).toBe(false);
  expect(r.problems.length).toBeGreaterThan(0);
  return r.problems.join("; ");
}

describe("checkPqOrigin: the attestation of programmable.json, which signs the typical rules", () => {
  it("re-verifies it: message v3 with the rules hash, the rules record read, verified for the launch's guard and explained", () => {
    const i = inputs();
    expect(PROG.attestation.rulesHash).toBe(PROG.rules[0]!.rulesHash);
    expect(toHex(rulesHash(TYPICAL))).toBe(PROG.rules[0]!.rulesHash);
    expect(launchRulesAddress(launchKey, fromHex(PROG.rules[0]!.rulesHash)).toBase58()).toBe(PROG.rules[0]!.address);
    const r = checkPqOrigin(i);
    expect(r.problems).toEqual([]);
    expect(r.message).toHaveLength(221);
    expect(toHex(r.message!)).toBe(PROG.attestation.message);
    expect(toHex(sha256(r.message!))).toBe(PROG.attestation.messageHash);
    // The SDK's message builder gives the same bytes from the same fields.
    const a = r.attestation!;
    expect(
      toHex(attestationMessage({ launch: launchKey, paramsHash: i.launch.paramsHash, creator: i.launch.creator, metadataHash: a.metadataHash, rulesHash: a.rulesHash, notBefore: a.notBefore, notAfter: a.notAfter })),
    ).toBe(PROG.attestation.message);
    const o = r.origin!;
    expect([o.verified, o.signatureValid, o.leaf]).toEqual([true, true, PROG.attestation.q]);
    expect(o.rules.hash).toBe(PROG.attestation.rulesHash);
    expect(o.rules.address?.toBase58()).toBe(PROG.rules[0]!.address);
    expect(toHex(o.rules.bytes)).toBe(PROG.rules[0]!.bytes);
    expect(o.rules.explanation).toEqual(explainRules(TYPICAL, { guardSecs: PROG.launch.guardSecs, tokenDecimals: i.launch.tokenDecimal }));
    expect(o.rules.explanation.join(" ")).toMatch(/Selling is always allowed.*switches off for good 1 hour after launch/);
    expect(toHex(r.rulesRecord!.bytes)).toBe(PROG.rules[0]!.bytes);
  });

  it("the signed rules must be readable: published, the launchpad's, at the signed hash's address, hashing to it", () => {
    let i = inputs();
    i.rules = null;
    expect(problemsOf(i)).toMatch(/launch rules the identity signed are not published at FdxCNH.*cannot be read/);
    i = inputs();
    delete i.rules; // omitted: the same
    expect(problemsOf(i)).toMatch(/are not published at/);
    i = inputs();
    i.rules = raw(rulesKey, fromHex(PROG.rules[0]!.accountData), PROGRAM_IDS.hook);
    expect(problemsOf(i)).toMatch(/launch rules record FdxCNH.* is not owned by the launchpad/);
    i = inputs();
    i.rules = raw(new PublicKey(PROG.rules[1]!.address), fromHex(PROG.rules[1]!.accountData));
    expect(problemsOf(i)).toMatch(/launch rules record read is not the signed one/);
    i = inputs();
    const data = fromHex(PROG.rules[0]!.accountData);
    data[data.length - 1]! ^= 1; // inside the rule bytes
    i.rules = raw(rulesKey, data);
    const p = problemsOf(i);
    expect(p).toMatch(/launch rules record is invalid .*do not hash to its stored rules hash/);
    expect(checkPqOrigin(i).origin?.rules.explanation).toEqual([]);
  });

  it("the signed rules must be valid for the launch's guard; the certificate must record the signed hash", () => {
    let i = inputs();
    i.launch.guardSecs = 60; // the typical rules run past one minute
    expect(problemsOf(i)).toMatch(/launch rules are not valid for this launch's 1 minute launch guard/);
    i = inputs();
    i.certificate.rulesHash = new Uint8Array(32);
    expect(problemsOf(i)).toMatch(/the identity signed launch rules, but the certificate records none/);
    i = inputs();
    i.certificate.rulesHash = fromHex(PROG.rules[1]!.rulesHash);
    expect(problemsOf(i)).toMatch(/the certificate records other launch rules than the ones the identity signed/);
  });

  it("a rules hash the identity did not sign (written into the attestation) breaks the message", () => {
    const i = inputs();
    const data = attestationData();
    data.set(fromHex(PROG.rules[1]!.rulesHash), 108); // rules_hash 108..140
    i.attestation = raw(i.attestation!.address, data);
    i.rules = raw(new PublicKey(PROG.rules[1]!.address), fromHex(PROG.rules[1]!.accountData));
    i.certificate.rulesHash = fromHex(PROG.rules[1]!.rulesHash);
    const p = problemsOf(i);
    expect(p).toMatch(/stored message hash is not the hash of the message rebuilt/);
    expect(p).toMatch(/signature does not verify/);
  });
});

describe("verifyAttestation with rules (before launch, from live accounts)", () => {
  function chain(): MockConnection {
    const conn = new MockConnection();
    conn.set(launchKey, { owner: PROGRAM_IDS.launchpad, data: fromHex(PROG.launch.data) });
    conn.set(attestationAddress(launchKey), { owner: PROGRAM_IDS.launchpad, data: attestationData() });
    conn.set(new PublicKey(PROG.identity.address), { owner: PROGRAM_IDS.launchpad, data: fromHex(PROG.identity.data) });
    conn.set(new PublicKey(PROG.launch.tokenMeta), { owner: PROGRAM_IDS.launchpad, data: fromHex(PROG.launch.tokenMetaData) });
    conn.set(rulesKey, { owner: PROGRAM_IDS.launchpad, data: fromHex(PROG.rules[0]!.accountData) });
    return conn;
  }

  it("verified: the rules record the identity signed is read and explained", async () => {
    const r = await verifyAttestation(chain().asConnection(), launchKey);
    expect(r.problems).toEqual([]);
    expect(r.verified).toBe(true);
    expect(toHex(r.launchRules!.bytes)).toBe(PROG.rules[0]!.bytes);
    expect(r.origin?.rules.hash).toBe(PROG.rules[0]!.rulesHash);
    expect(r.origin?.rules.explanation.length).toBeGreaterThan(3);
    expect(r.origin?.rules.explanation.join(" ")).toMatch(/switches off for good 1 hour after launch/);
  });

  it("not verified when the signed rules record is missing", async () => {
    const conn = chain();
    conn.delete(rulesKey);
    const r = await verifyAttestation(conn.asConnection(), launchKey);
    expect([r.verified, r.origin?.verified, r.launchRules]).toEqual([false, false, null]);
    expect(r.problems.join()).toMatch(/launch rules the identity signed are not published/);
  });
});

// ------------------------------------------------------- verifyLaunch ---

/** The verifier's world: attested by the vector identity, batch executed. */
function world(): PqWorld {
  return withPq(unattestedWorld());
}

async function verify(w: World): Promise<VerificationReport> {
  w.build();
  return verifyLaunch(w.conn.asConnection(), w.mint);
}

const check = (r: VerificationReport, id: string) => r.checks.find((c) => c.id === id);
const detail = (r: VerificationReport, id: string): string => check(r, id)?.detail ?? "missing";

async function expectCheck(w: World, id: string, want: "fail" | "warn" | "pass"): Promise<VerificationReport> {
  const r = await verify(w);
  expect(check(r, id)?.status, `${id}: ${detail(r, id)}`).toBe(want);
  if (want === "fail") expect(r.overall).toBe("fail");
  return r;
}

describe("verifyLaunch: launch rules bound to the Launch Guard", () => {
  it("rules bound: every check passes, checks = 8,191, the report shows the signed rules in plain English", async () => {
    for (const bytes of [TYPICAL, LARGEST]) {
      const w = withRules(world(), bytes);
      const r = await verify(w);
      expect(r.checks.filter((c) => c.status !== "pass")).toEqual([]);
      expect(r.overall).toBe("pass");
      expect(r.certificate?.checks).toBe(PROG.parameters.certificate.withRules);
      expect(detail(r, "certificate.checks")).toMatch(/^checks = 8191: .*RULES_BOUND \(4096\): the program found the creator's signed launch rules in the Launch Guard/);
      const hash = toHex(rulesHash(bytes));
      const explanation = explainRules(bytes, { guardSecs: 6 * 3600, tokenDecimals: 6 });
      expect(r.rules).toEqual({ hash, address: worldRulesAddress(w, bytes), bytes, explanation, boundInPolicy: true, verified: true });
      expect(explanation.join(" ")).toMatch(/switches off for good 6 hours after launch/);
      expect(detail(r, "launch.rules")).toContain(`signed these launch rules (hash ${hash}`);
      expect(detail(r, "launch.rules")).toContain(explanation[0]!);
      expect(r.pqOrigin?.rules).toEqual({ hash, address: worldRulesAddress(w, bytes), bytes, explanation });
      expect(detail(r, "pq.origin")).toContain(`It also signed the launch rules with hash ${hash}`);
    }
  });

  it("the Launch Guard's rules are not the record's (mutated, emptied, or rules where none were signed)", async () => {
    let w = withRules(world(), TYPICAL);
    const mutated = TYPICAL.slice();
    mutated[mutated.length - 1]! ^= 1;
    w.policy["rules"] = mutated;
    let r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toBe("the Launch Guard enforces other launch rules than the ones the certificate records");
    expect([r.rules?.boundInPolicy, r.rules?.verified]).toEqual([false, false]);
    expect(check(r, "pq.origin")?.status).toBe("pass"); // the attestation itself is fine
    w = withRules(world(), TYPICAL);
    w.policy["rules"] = new Uint8Array(0);
    r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toMatch(/the Launch Guard enforces no launch rules, but the certificate records some/);
    w = world();
    w.policy["rules"] = TYPICAL;
    r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toMatch(/the Launch Guard enforces launch rules, but the certificate records none/);
    expect(r.rules?.boundInPolicy).toBe(false);
  });

  it("the certificate's rules hash is not the attested one", async () => {
    // Another (published) rule set recorded in the certificate and held by the Launch Guard.
    let w = withRules(world(), TYPICAL);
    const otherHash = rulesHash(LARGEST);
    w.cert["rulesHash"] = otherHash;
    w.policy["rules"] = LARGEST;
    const build = w.build;
    w.build = () => {
      build();
      // The record the certificate names, as publish_rules writes it for this launch.
      w.conn.set(worldRulesAddress(w, LARGEST), { owner: PROGRAM_IDS.launchpad, data: emulatedLaunchRulesBytes(w.launch, LARGEST) });
    };
    let r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toBe("the certificate records other launch rules than the ones the creator signed");
    expect(detail(r, "pq.origin")).toMatch(/the certificate records other launch rules than the ones the identity signed/);
    // The origin still shows what the identity signed (its record is read too).
    expect(r.pqOrigin?.rules.hash).toBe(toHex(rulesHash(TYPICAL)));
    expect(r.pqOrigin?.rules.bytes).toEqual(TYPICAL);
    // The certificate records none although the identity signed rules.
    w = withRules(world(), TYPICAL);
    w.cert["rulesHash"] = new Uint8Array(32);
    w.cert["checks"] = 4095;
    w.policy["rules"] = new Uint8Array(0);
    r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toMatch(/the creator signed launch rules, but the certificate records none/);
    expect(r.rules?.hash).toBe(ZERO_HEX);
    expect(r.pqOrigin?.rules.bytes).toEqual(TYPICAL);
  });

  it("RULES_BOUND missing with rules, or set without rules", async () => {
    let w = withRules(world(), TYPICAL);
    w.cert["checks"] = 4095;
    let r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toMatch(/the launch has rules, but the certificate does not record that the Launch Guard holds them \(RULES_BOUND\)/);
    expect(check(r, "certificate.checks")?.status).toBe("pass");
    w = world();
    w.cert["checks"] = 8191;
    r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toMatch(/the certificate says the Launch Guard holds launch rules \(RULES_BOUND\), but there are none/);
    expect(check(r, "certificate.checks")?.status).toBe("pass");
  });

  it("the signed rules record is missing, or the rules are not valid for the launch's guard", async () => {
    let w = withRules(world(), TYPICAL);
    w.pq.rulesAccount = "missing";
    let r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toMatch(/the launch rules are not published at .*, the address the certificate names/);
    expect(detail(r, "pq.origin")).toMatch(/launch rules the identity signed are not published/);
    expect(r.rules?.bytes).toHaveLength(0);
    // Rules that end after this launch's 6-hour guard: fine for a 72-hour guard, refused for this launch.
    const raw = decodeRulesRaw(TYPICAL);
    raw.rules[0]!.toRel = 30_000;
    const late = encodeRulesRaw(raw);
    w = withRules(world(), late);
    r = await expectCheck(w, "launch.rules", "fail");
    expect(detail(r, "launch.rules")).toMatch(/the launch rules are not valid for this launch's 6 hours launch guard/);
    expect(r.rules?.explanation).toEqual([]);
    expect(check(r, "pq.origin")?.status).toBe("fail");
  });
});

describe("verifyLaunch: certificate checks are tested with the mask, never compared with 4,095", () => {
  it("8,191 (4,095 + RULES_BOUND) passes; a required bit missing fails even with RULES_BOUND; unknown bits warn", async () => {
    let w = withRules(world(), TYPICAL);
    await expectCheck(w, "certificate.checks", "pass");
    w = withRules(world(), TYPICAL);
    w.cert["checks"] = 8191 & ~1024; // RULES_BOUND set, PQ_ATTESTED missing
    let r = await expectCheck(w, "certificate.checks", "fail");
    expect(detail(r, "certificate.checks")).toMatch(/^checks = 7167: PQ_ATTESTED not recorded; every launch records all twelve \(4095\)/);
    w = world();
    w.cert["checks"] = 4095 & ~1 & ~2048;
    r = await expectCheck(w, "certificate.checks", "fail");
    expect(detail(r, "certificate.checks")).toMatch(/MINT_AUTHORITY_NONE, METADATA_ONCHAIN not recorded/);
    w = world();
    w.cert["checks"] = 4095 | 8192;
    r = await expectCheck(w, "certificate.checks", "warn");
    expect(detail(r, "certificate.checks")).toMatch(/flags this verifier does not know \(8192\)/);
  });
});

describe("verifyLaunch: launches without rules", () => {
  it("a launch without rules shows \"No launch rules\"", async () => {
    const w = world();
    const r = await expectCheck(w, "launch.rules", "pass");
    expect(detail(r, "launch.rules")).toMatch(/^No launch rules: the creator signed none and the Launch Guard holds none, so only the standard launch protections apply\.$/);
    expect(r.rules).toEqual({ hash: ZERO_HEX, address: null, bytes: new Uint8Array(0), explanation: [expect.stringMatching(/^No launch rules/)], boundInPolicy: true, verified: true });
    expect(detail(r, "certificate.checks")).not.toMatch(/RULES_BOUND/);
  });

  it("a version-3 certificate (487 bytes, before rules existed) still verifies, with no launch rules; RULES_BOUND on it fails", async () => {
    const v3 = (w: World): void => {
      w.cert["version"] = CERTIFICATE.V3_VERSION;
      const build = w.build;
      w.build = () => {
        build();
        const bytes = accountBytes("launchpad", "Certificate", w.cert).slice(0, CERTIFICATE.V3_ACCOUNT_LEN);
        w.conn.set(certificateAddress(w.mint), { owner: PROGRAM_IDS.launchpad, data: bytes });
      };
    };
    let w = world();
    v3(w);
    const r = await verify(w);
    expect(r.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(r.overall).toBe("pass");
    expect([r.certificate?.version, toHex(r.certificate!.rulesHash)]).toEqual([3, ZERO_HEX]);
    expect(detail(r, "certificate.account")).toMatch(/^Certificate v3 \(written before launch rules existed: it records none\), safety policy v3\./);
    expect(detail(r, "launch.rules")).toMatch(/^No launch rules: .*\(version-3 certificate, written before launch rules existed\)/);
    expect(r.rules?.verified).toBe(true);
    w = world();
    v3(w);
    w.cert["checks"] = 8191;
    const bad = await expectCheck(w, "launch.rules", "fail");
    expect(detail(bad, "launch.rules")).toMatch(/the certificate is version 3, from before launch rules existed, yet it says the Launch Guard holds launch rules/);
  });
});

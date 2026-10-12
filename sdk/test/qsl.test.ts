/**
 * QSL-1 (docs/standard/QSL-1.md) from the SDK: `checkQsl1`, `evaluateQsl1`
 * and `qslBadge`, on the certified launch of `./qslFixtures.ts` (the Rust
 * vectors' attestation, identity and record verbatim; certificate, launch
 * and hook policy at the standard's offsets).
 *
 * - every condition C1.1..C1.24 and C2.1..C2.8: the fixture passes it, and
 *   each field the standard lists is broken once, failing exactly that
 *   condition's check (so each case fails without the condition's code);
 * - certificate versions 3 and 4 (each with its own attestation and hook
 *   policy generation) and C1.3's mask (`(checks & 4095) == 4095`);
 * - the level, `candidate` (programs still upgradeable, or not mainnet),
 *   `wouldBe`, the reasons, graduation and migration, the programmable
 *   component not present without launch rules or autopilot (the component
 *   itself: `qslProgrammable.test.ts`);
 * - the reads (§7.10: two `getMultipleAccounts` before migration, at
 *   `finalized`, the second with `minContextSlot`; no `getProgramAccounts`);
 * - the layouts: bytes written at QSL-1 §5's offsets decode through the
 *   programs' IDLs to the same fields, the Rust attestation re-encodes byte
 *   for byte, the §5.7 hex is the canonical account list, and the §11.2
 *   worked example holds;
 * - the badge (Appendix A): labels, the standard's lines, trade screens,
 *   and none of the words A.3 forbids.
 */
import { readdirSync, readFileSync } from "node:fs";

import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { decodeAttestation, decodeCertificate, decodeLaunch } from "../src/launch/accounts.js";
import { metadataHashV2 } from "../src/metadata/record.js";
import { attestationAddress, certificateAddress, dbcPoolAddress, extraAccountMetaListAddress, hookPolicyAddress, identityAddressFromId, programDataAddress } from "../src/pda.js";
import { lmsVerify } from "../src/pq/lms.js";
import { qslBadge, QSL1_LEVEL_NAMES } from "../src/qsl/badge.js";
import { checkQsl1, evaluateQsl1, QSL1_CONDITION_IDS, type QslAccount, type QslResult } from "../src/qsl/check.js";
import { QSL1, readAttestation, readCertificate, readHookPolicy, readIdentity } from "../src/qsl/layouts.js";
import { GENESIS_HASHES } from "../src/rpc/cluster.js";
import { expectedMetaListData } from "../src/verify/verifyLaunch.js";
import { ext, key, readJson, SPL, upgradeableProgram } from "./helpers.js";
import { addLp, attestationBytes, attestRecord, certificateBytes, graduate, launchBytes, legacy, patch, policyBytes, PROG, qslWorld, SUPPLY, VECTOR_RECORD, type QslWorld } from "./qslFixtures.js";
import { LMS } from "./verifyFixtures.js";
import { accountBytes, metaListBytes } from "./world.js";

const ATTESTATION = new PublicKey(LMS.accounts.attestation.address);
const IDENTITY = identityAddressFromId(fromHex(LMS.identity.identityId));
const RECORD = new PublicKey(LMS.accounts.tokenMeta.address);

async function run(w: QslWorld): Promise<QslResult> {
  w.build();
  return checkQsl1(w.conn.asConnection(), w.mint);
}
const check = (r: QslResult, id: string) => {
  const c = r.checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};
const statusOf = (r: QslResult, id: string): string => check(r, id).status;
/** The ids that did not pass (fail, warn or skip). */
const notPassing = (r: QslResult): string[] => r.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
const del = (w: QslWorld, a: PublicKey): void => {
  w.patches.push(() => w.conn.delete(a));
};
const reown = (w: QslWorld, a: PublicKey, owner: PublicKey): void => {
  w.patches.push(() => w.conn.set(a, { ...w.conn.get(a)!, owner }));
};
const recordMeta = (): { name: string; symbol: string; uri: string; additional: [string, string][] } => ({ name: VECTOR_RECORD.name, symbol: VECTOR_RECORD.symbol, uri: "", additional: [] });
/** The programmable component's checks on a token without launch rules or autopilot: each "not used" (a skip that is ok). */
const P_NOT_USED = ["P.R1:skip", "P.R2:skip", "P.R3:skip", "P.R4:skip", "P.G1:skip", "P.G2:skip", "P.G3:skip", "P.G4:skip", "P.G5:skip"];
const partsNotPassing = (r: QslResult): string[] => r.programmable.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
/** Attestation v3 offsets (2,708 bytes): rules_hash 108, message_hash 140, signature length 196, signature 200. */
const ATT = { RULES_HASH: 108, MESSAGE_HASH: 140, SIG_LEN: 196 } as const;
const cfg = (w: QslWorld): Record<string, unknown> => w.config.config;
const ps = (w: QslWorld): Record<string, unknown> => w.poolState.poolState;
const u64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};

// ------------------------------------------------------------- the fixture ---

describe("the certified launch (Rust vectors + QSL-1 layouts)", () => {
  it("is QSL-1 level 2 on mainnet with finalized programs: every condition passes, the LP check waits for migration, nothing blocks (level 2 is the top), not programmable", async () => {
    const r = await run(qslWorld());
    expect(notPassing(r)).toEqual(["C1.23:skip"]);
    expect(partsNotPassing(r)).toEqual(P_NOT_USED);
    expect([r.level, r.candidate, r.wouldBe, r.cluster, r.graduated, r.migrated, r.certificateVersion]).toEqual([2, false, 2, "mainnet", false, false, 4]);
    expect(r.standard).toBe("QSL-1");
    expect(r.components).toEqual({ rules: false, autopilot: false });
    expect([r.rules, r.autopilot]).toEqual([null, null]);
    expect(r.blocking).toEqual([]);
    expect(r.reasons).toEqual([]);
    expect(r.programmable).toMatchObject({ present: false, verified: true, warnings: [] });
    expect(check(r, "C1.23").ok).toBe(true);
    expect(r.programmable.checks.every((c) => c.ok)).toBe(true);
    expect(r.programmable.checks.find((c) => c.id === "P.R1")!.plain).toBe("Not used: it has no launch rules.");
    expect(r.programmable.checks.find((c) => c.id === "P.G1")!.plain).toBe("Not used: no automation is running for this token.");
    expect(r.checks.map((c) => c.id)).toEqual(QSL1_CONDITION_IDS);
    expect(r.checks.map((c) => c.level)).toEqual(QSL1_CONDITION_IDS.map((id) => (id.startsWith("C2.") ? 2 : 1)));
    // The vector's signature is re-verified at its leaf (511) over the message rebuilt from on-chain data.
    expect(check(r, "C2.6").detail).toMatch(/verifies at leaf 511/);
    expect(r.slot).toBe(400_000_000);
    expect(r.uriMode).toBe(0);
    // §6.6 and §8.2.
    expect(r.info.map((i) => i.id).sort()).toEqual(["info.batch", "info.dammV2", "info.dbc", "info.leaves", "info.token2022", "info.uri"]);
    expect(r.info.every((i) => i.status === "pass")).toBe(true);
    expect(r.trusted.some((t) => t.kind === "upgrade-multisig")).toBe(true);
    expect(r.trusted.find((t) => t.name === "Noised launchpad upgrade authority")?.note).toMatch(/finalized/);
  });

  it("evaluateQsl1 on the same accounts gives the same result (pure)", async () => {
    const w = qslWorld();
    const live = await run(w);
    const accounts = new Map<string, QslAccount | null>();
    for (const [k, a] of w.conn.accounts) accounts.set(k, { owner: a.owner, data: a.data, executable: a.executable ?? false });
    const offline = evaluateQsl1({ mint: w.mint, genesisHash: GENESIS_HASHES.mainnet, slot: 400_000_000, accounts, launchAuthorityTokenAccounts: null });
    expect(JSON.stringify(offline, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v))).toBe(
      JSON.stringify(live, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v)),
    );
  });
});

// -------------------------------------------------------------- the reads ---

describe("checkQsl1 reads (§7.1, §7.10)", () => {
  it("genesis hash, then two getMultipleAccounts at finalized, the second no older than the first; nothing else", async () => {
    const w = qslWorld();
    await run(w);
    expect(w.conn.calls).toEqual(["getGenesisHash", "getMultipleAccountsInfoAndContext", "getMultipleAccountsInfoAndContext"]);
    expect(w.conn.readConfigs.map((c) => c.config)).toEqual([{ commitment: "finalized" }, { commitment: "finalized", minContextSlot: 400_000_000 }]);
    // Step 1 merges the programs into the first read: mint, certificate, policy, account list, 5 programs and their ProgramData.
    // Step 3 reads the launch, config, pool, attestation, record, identity and (the programmable component) the launch's autopilot address.
    expect(w.conn.readConfigs.map((c) => c.keys)).toEqual([14, 7]);
  });

  it("after migration: one getTokenAccountsByOwner and the positions and pools, each no older than the reads before; still no getProgramAccounts", async () => {
    const w = qslWorld();
    graduate(w, true);
    addLp(w);
    const r = await run(w);
    expect(r.level).toBe(2);
    expect(w.conn.calls).toEqual(["getGenesisHash", "getMultipleAccountsInfoAndContext", "getMultipleAccountsInfoAndContext", "getTokenAccountsByOwner", "getMultipleAccountsInfoAndContext", "getMultipleAccountsInfoAndContext"]);
    expect(w.conn.readConfigs.slice(2).every((c) => (c.config as { minContextSlot?: number }).minContextSlot === 400_000_000)).toBe(true);
  });

  it("commitment: confirmed when asked; anything else, and a mint that is not a PublicKey, is refused before any read", async () => {
    const w = qslWorld();
    await checkQsl1(w.conn.asConnection(), w.mint, { commitment: "confirmed" });
    expect((w.conn.readConfigs[0]!.config as { commitment: string }).commitment).toBe("confirmed");
    const c = qslWorld().conn;
    await expect(checkQsl1(c.asConnection(), w.mint, { commitment: "processed" as "confirmed" })).rejects.toThrow(/commitment/);
    await expect(checkQsl1(c.asConnection(), w.mint.toBase58() as unknown as PublicKey)).rejects.toThrow(TypeError);
    expect(c.calls).toEqual([]);
  });
});

// ------------------------------------------------------- cluster and levels ---

describe("cluster, finality and the level (§7.1, §7.9, C1.24)", () => {
  it("devnet: no level; a candidate when everything else holds", async () => {
    const w = qslWorld();
    w.genesisHash = GENESIS_HASHES.devnet;
    const r = await run(w);
    expect([r.level, r.candidate, r.wouldBe, r.cluster]).toEqual([0, true, 2, "devnet"]);
    expect(r.blocking).toEqual(["cluster"]);
    expect(check(r, "cluster").plain).toMatch(/devnet, a test network/);
  });

  it("real devnet, by the genesis hash devnet serves (`solana genesis-hash -u devnet`, 2026-10-10), reads as devnet (SDK 0.5.0 had a wrong hash: 'other')", async () => {
    const w = qslWorld();
    w.genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    const r = await run(w);
    expect([r.cluster, statusOf(r, "cluster"), r.level, r.candidate]).toEqual(["devnet", "fail", 0, true]);
    expect(check(r, "cluster").detail).toBe("genesis hash EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: devnet");
    expect(qslBadge(r).lines).toContain("This is Solana devnet, a test network; levels are given only on mainnet.");
  });

  it("another cluster, or a genesis hash that cannot be read: no level", async () => {
    const w = qslWorld();
    w.genesisHash = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";
    let r = await run(w);
    expect([r.level, r.cluster, statusOf(r, "cluster")]).toEqual([0, "other", "fail"]);
    const v = qslWorld();
    v.build();
    v.conn.getGenesisHash = () => Promise.reject(new Error("no"));
    r = await checkQsl1(v.conn.asConnection(), v.mint);
    expect([r.level, r.cluster, r.candidate]).toEqual([0, "unknown", true]);
  });

  it("C1.24: an upgradeable launchpad withholds every level: candidate (would be 2)", async () => {
    const w = qslWorld();
    w.upgradeAuthority.launchpad = key("qsl/upgrader");
    const r = await run(w);
    expect([r.level, r.candidate, r.wouldBe]).toEqual([0, true, 2]);
    expect(statusOf(r, "C1.24")).toBe("fail");
    expect(r.blocking).toEqual(["C1.24"]);
    expect(r.reasons).toEqual(["Noised's programs can still be updated by their team, so no level can be given yet."]);
  });

  it("C1.24: an upgradeable hook counts while the hook is active, not after graduation", async () => {
    const w = qslWorld();
    w.upgradeAuthority.hook = key("qsl/upgrader");
    let r = await run(w);
    expect([r.level, r.candidate, statusOf(r, "C1.24")]).toEqual([0, true, "fail"]);
    const g = qslWorld();
    g.upgradeAuthority.hook = key("qsl/upgrader");
    graduate(g, false);
    r = await run(g);
    expect([r.level, r.candidate, statusOf(r, "C1.24")]).toEqual([2, false, "pass"]);
    expect(check(r, "C1.24").detail).toMatch(/no longer counts/);
  });

  it("C1.24: unreadable programs are not 'not final yet': no level and no candidate", async () => {
    const cases: ((w: QslWorld) => void)[] = [
      (w) => del(w, programDataAddress(PROGRAM_IDS.launchpad)),
      (w) => w.patches.push(() => w.conn.set(PROGRAM_IDS.launchpad, { ...w.conn.get(PROGRAM_IDS.launchpad)!, executable: false })),
      (w) => w.patches.push(() => upgradeableProgram(w.conn, PROGRAM_IDS.hook, key("qsl/elsewhere"), 1n, null)),
      (w) => patch(w, programDataAddress(PROGRAM_IDS.launchpad), (d) => void (d[0] = 2)),
    ];
    for (const [i, mutate] of cases.entries()) {
      const w = qslWorld();
      mutate(w);
      const r = await run(w);
      expect([i, statusOf(r, "C1.24"), r.level, r.candidate, r.wouldBe]).toEqual([i, "fail", 0, false, 2]);
    }
  });

  it("level 1 when a level-2 condition fails; candidate 1 when the programs are upgradeable too", async () => {
    const w = qslWorld();
    patch(w, ATTESTATION, (d) => void (d[300]! ^= 1));
    let r = await run(w);
    expect([r.level, r.wouldBe, r.candidate]).toEqual([1, 1, false]);
    expect(r.blocking).toEqual(["C2.6"]);
    expect(r.reasons).toEqual(["The quantum-resistant signature does not check out."]);
    w.upgradeAuthority.launchpad = key("qsl/upgrader");
    r = await run(w);
    expect([r.level, r.wouldBe, r.candidate]).toEqual([0, 1, true]);
  });

  it("a failed level-1 condition: level 0, not a candidate, its plain sentence as the reason", async () => {
    const w = qslWorld();
    w.upgradeAuthority.launchpad = key("qsl/upgrader");
    w.mintOpts.freezeAuthority = key("qsl/freezer");
    const r = await run(w);
    expect([r.level, r.wouldBe, r.candidate]).toEqual([0, 0, false]);
    expect(r.blocking).toEqual(["C1.6", "C1.24"]);
    expect(r.reasons[0]).toBe("Someone can freeze holders' tokens.");
  });
});

// ---------------------------------------------------- step 1: certificate ---

describe("C1.1 to C1.3: the certificate (a failure stops the run: not QSL-1)", () => {
  const cert = (w: QslWorld): PublicKey => certificateAddress(w.mint);
  it.each<[string, string, (w: QslWorld) => void]>([
    ["no certificate", "C1.1", (w) => del(w, cert(w))],
    ["owned by another program", "C1.1", (w) => reown(w, cert(w), PROGRAM_IDS.hook)],
    ["520 bytes", "C1.1", (w) => patch(w, cert(w), (d) => concatBytes([d, new Uint8Array(1)]))],
    ["488 bytes (version 3 plus one)", "C1.1", (w) => void ((w.cert.version = 3), (w.cert.rulesHash = null), patch(w, cert(w), (d) => concatBytes([d, new Uint8Array(1)])))],
    ["another account's discriminator", "C1.1", (w) => patch(w, cert(w), (d) => void d.set(fromHex(QSL1.LAUNCH.DISCRIMINATOR), 0))],
    ["version 5", "C1.2", (w) => void (w.cert.version = 5)],
    ["version 3 at 519 bytes", "C1.2", (w) => void (w.cert.version = 3)],
    ["version 4 at 487 bytes", "C1.2", (w) => void (w.cert.rulesHash = null)],
    ["a non-canonical bump", "C1.2", (w) => void (w.cert.bump = (w.cert.bump + 1) % 256)],
    ["another base_mint", "C1.2", (w) => void (w.cert.baseMint = key("qsl/other-mint"))],
    ["policy version 2", "C1.2", (w) => void (w.cert.policyVersion = 2)],
    ["checks 4,094", "C1.3", (w) => void (w.cert.checks = 4_094)],
    ["checks 8,191 without a rules_hash (RULES_BOUND set alone)", "C1.3", (w) => void (w.cert.checks = 8_191)],
    ["checks 4,095 with a rules_hash (RULES_BOUND missing)", "C1.3", (w) => void (w.cert.rulesHash = sha256(utf8("rules")))],
    ["checks 4,095 | 8,192 (a bit this checker does not know)", "C1.3", (w) => void (w.cert.checks = 4_095 | 8_192)],
    ["checks 8,191 + 8,192 with a rules_hash (an unknown bit beside RULES_BOUND)", "C1.3", (w) => void ((w.cert.checks = 8_191 | 8_192), (w.cert.rulesHash = sha256(utf8("rules"))))],
    ["checks 2^31 + 4,095 (the top bit)", "C1.3", (w) => void (w.cert.checks = 2 ** 31 + 4_095)],
    ["a version-3 certificate with RULES_BOUND (exactly 4,095 required)", "C1.3", (w) => void ((w.cert.version = 3), (w.cert.rulesHash = null), (w.cert.checks = 8_191))],
  ])("%s: %s fails and nothing after it is checked", async (_, id, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, id)).toBe("fail");
    expect([r.level, r.wouldBe, r.candidate]).toEqual([0, 0, false]);
    const notChecked = r.checks.filter((c) => c.status === "skip" && !c.ok).map((c) => c.id);
    expect(notChecked).toContain("C2.6");
    expect(notChecked).toContain("C1.4");
    expect(r.blocking).toEqual([id]);
    expect(r.info.filter((i) => !["info.dbc", "info.dammV2", "info.token2022"].includes(i.id))).toEqual([]);
  });

  it("C2.1 (bits 1024 and 2048) is implied by C1.3: it passes on every certificate the run gets past C1.3 with", async () => {
    const r = await run(qslWorld());
    expect(statusOf(r, "C2.1")).toBe("pass");
    const w = qslWorld();
    w.cert.checks = 4_095 & ~1_024;
    const s = await run(w);
    expect([statusOf(s, "C1.3"), statusOf(s, "C2.1"), check(s, "C2.1").ok]).toEqual(["fail", "skip", false]);
  });

  it("the not-QSL-1 result: no certificate, 'Not QSL-1', no launchpad account read beyond step 1", async () => {
    const w = qslWorld();
    del(w, certificateAddress(w.mint));
    const r = await run(w);
    expect(check(r, "C1.1").plain).toBe("It has no valid Noised launch certificate, so none of these protections apply.");
    expect(check(r, "C1.4").plain).toBe("Not checked: this token has no Noised launch certificate.");
    expect(w.conn.readConfigs).toHaveLength(1);
  });
});

describe("certificate versions 3 and 4, and C1.3's mask (amendment A2)", () => {
  it("both generations are evaluated: version 4 (519 bytes, attestation v3, policy v2) and version 3 (487 bytes, attestation v2 over message v2, policy v1) reach level 2", async () => {
    const w4 = qslWorld();
    const w3 = qslWorld();
    legacy(w3);
    for (const [w, version, certLen, attLen, policyLen, msgLen] of [
      [w4, 4, 519, 2_708, 279, 221],
      [w3, 3, 487, 2_676, 275, 189],
    ] as const) {
      const r = await run(w);
      expect([r.certificateVersion, r.level, r.wouldBe, notPassing(r), partsNotPassing(r)]).toEqual([version, 2, 2, ["C1.23:skip"], P_NOT_USED]);
      expect([w.conn.get(certificateAddress(w.mint))!.data.length, w.conn.get(attestationAddress(w.launch))!.data.length, w.conn.get(hookPolicyAddress(w.mint))!.data.length]).toEqual([certLen, attLen, policyLen]);
      expect(check(r, "C1.1").detail).toMatch(new RegExp(`${certLen} bytes`));
      expect(check(r, "C2.2").detail).toMatch(new RegExp(`version ${version === 4 ? 3 : 2},`));
      expect(check(r, "C2.4").detail).toMatch(new RegExp(`${msgLen}-byte message v${version === 4 ? 3 : 2}`));
      expect(check(r, "C2.6").detail).toMatch(/verifies at leaf 511/);
      expect(r.programmable.checks.find((c) => c.id === "P.R1")!.detail).toBe(version === 3 ? "a version-3 certificate binds no launch rules" : "the certificate's rules_hash is zero: the launch has no launch rules");
    }
  });

  it("each generation's accounts only go with their own certificate version: a v2 attestation or a v1 policy under a version-4 certificate fails, and the reverse", async () => {
    // A version-4 certificate with the version-3 generation's attestation (2,676 bytes) and policy (275 bytes).
    const a = qslWorld();
    legacy(a);
    a.cert.version = 4;
    a.cert.rulesHash = new Uint8Array(32);
    let r = await run(a);
    expect([statusOf(r, "C2.2"), statusOf(r, "C1.21"), r.level]).toEqual(["fail", "fail", 0]);
    expect(check(r, "C2.2").detail).toBe("the attestation is 2676 bytes, expected 2708 (version 3, with a version-4 certificate)");
    // A version-3 certificate with today's attestation v3 and policy v2.
    const b = qslWorld();
    b.cert.version = 3;
    b.cert.rulesHash = null;
    r = await run(b);
    expect([statusOf(r, "C2.2"), statusOf(r, "C1.21"), r.level]).toEqual(["fail", "fail", 0]);
  });

  it("C1.3 tests (checks & 4,095) == 4,095: 8,191 with a rules_hash passes, and no QSL source compares checks with 4,095 for equality", async () => {
    const w = qslWorld();
    w.cert.checks = 8_191;
    w.cert.rulesHash = sha256(utf8("rules"));
    const r = await run(w);
    expect([statusOf(r, "C1.3"), check(r, "C1.3").detail]).toEqual(["pass", "checks = 8191: (checks & 4,095) = 4,095, all twelve bits; RULES_BOUND (4,096) with a non-zero rules_hash"]);
    // The rules bound but nothing behind them (no record, an attestation without them): C1.3 holds, the rest fails where it reads them.
    expect(statusOf(r, "C2.2")).toBe("fail");
    expect(statusOf(r, "C1.21")).toBe("fail");
    // The source of every QSL module: never `checks === 4095` (or the constant), never `== 4095`.
    const dir = new URL("../src/qsl/", import.meta.url);
    for (const f of readdirSync(dir)) {
      // The code, without its comments (which say what never to write).
      const src = readFileSync(new URL(f, dir), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/checks\s*[!=]==?\s*(4_?095|QSL1\.ALL_CHECKS)/);
      expect(src, f).not.toMatch(/(4_?095|QSL1\.ALL_CHECKS)\s*[!=]==?\s*(cert\.)?checks/);
    }
    const masked = readFileSync(new URL("check.ts", dir), "utf8");
    expect(masked).toMatch(/checks & QSL1\.ALL_CHECKS/);
  });
});

// ---------------------------------------------------------- step 2: mint ---

describe("C1.4 to C1.9: the mint", () => {
  it.each<[string, string, (w: QslWorld) => void]>([
    ["9 decimals (the certificate says 6)", "C1.4", (w) => void (w.mintOpts.decimals = 9)],
    ["supply above the initial supply", "C1.4", (w) => void (w.mintOpts.supply = SUPPLY + 1n)],
    ["owned by SPL Token", "C1.4", (w) => void (w.mintOpts.owner = SPL)],
    ["not initialized", "C1.4", (w) => patch(w, w.mint, (d) => void (d[45] = 0))],
    ["account type byte 2 (a token account)", "C1.4", (w) => patch(w, w.mint, (d) => void (d[165] = 2))],
    ["a mint authority", "C1.5", (w) => void (w.mintOpts.mintAuthority = key("qsl/minter"))],
    ["a freeze authority", "C1.6", (w) => void (w.mintOpts.freezeAuthority = key("qsl/freezer"))],
    ["a metadata update authority", "C1.7", (w) => void (w.mintMetadata = { ...recordMeta(), updateAuthority: key("qsl/updater") })],
    ["TokenMetadata naming another mint", "C1.7", (w) => void (w.mintMetadata = { ...recordMeta(), metadataMint: key("qsl/other-mint") })],
    ["a metadata pointer authority", "C1.8", (w) => void (w.mintOpts.extensions[0] = ext.metadataPointer(key("qsl/pointer"), w.mint))],
    ["a metadata pointer elsewhere", "C1.8", (w) => void (w.mintOpts.extensions[0] = ext.metadataPointer(null, key("qsl/elsewhere")))],
    ["a fourth extension (permanent delegate None)", "C1.9", (w) => void w.mintOpts.extensions.push(ext.permanentDelegate(null))],
    ["a second metadata pointer", "C1.9", (w) => void w.mintOpts.extensions.push(ext.metadataPointer(null, w.mint))],
    ["bytes after the TLV terminator", "C1.9", (w) => void (w.mintOpts.trailing = Uint8Array.of(0, 0, 0, 0, 7))],
  ])("%s: %s fails", async (_, id, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, id), check(r, id).detail).toBe("fail");
    expect(r.level).toBe(0);
  });

  it("C1.4: burns lower the supply (below the initial supply passes)", async () => {
    const w = qslWorld();
    w.mintOpts.supply = SUPPLY - 1n;
    expect((await run(w)).level).toBe(2);
  });

  it("a mint that does not parse fails every condition that reads it (fail closed)", async () => {
    const w = qslWorld();
    patch(w, w.mint, (d) => void (d[0] = 2)); // invalid COption tag
    const r = await run(w);
    for (const id of ["C1.4", "C1.5", "C1.6", "C1.7", "C1.8", "C1.9", "C1.10", "C2.8"]) expect([id, statusOf(r, id)]).toEqual([id, "fail"]);
  });
});

// ------------------------------------------- step 3: the transfer hook ---

describe("C1.10: the transfer hook against graduation", () => {
  it.each<[string, (w: QslWorld) => void]>([
    ["another hook program", (w) => void (w.mintOpts.extensions[1] = ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, key("qsl/evil-hook")))],
    ["another hook authority", (w) => void (w.mintOpts.extensions[1] = ext.transferHook(key("qsl/evil"), PROGRAM_IDS.hook))],
    ["revoked before graduation", (w) => void (w.mintOpts.extensions[1] = ext.transferHook(null, null))],
    [
      "still active after graduation",
      (w) => {
        graduate(w, false);
        w.mintOpts.extensions[1] = ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook);
      },
    ],
    ["graduation unknown (pool unreadable)", (w) => del(w, dbcPoolAddress(w.pdas.dbcConfig, w.mint))],
  ])("%s: fails", async (_, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, "C1.10"), check(r, "C1.10").detail).toBe("fail");
  });

  it("graduated (curve complete, migration pending): revoked hook passes; the policy becomes a SHOULD, the account list does not apply; level 2", async () => {
    const w = qslWorld();
    graduate(w, false);
    const r = await run(w);
    expect([r.level, r.graduated, r.migrated]).toEqual([2, true, false]);
    expect(check(r, "C1.10").plain).toBe("The launch guard switched off when it graduated: it is a plain token now.");
    expect([statusOf(r, "C1.22"), check(r, "C1.22").ok]).toEqual(["skip", true]);
    expect([statusOf(r, "C1.23"), check(r, "C1.23").ok]).toEqual(["skip", true]);
    expect(r.info.find((i) => i.id === "info.graduation")?.status).toBe("pass");
  });

  it("graduation by quote reserve alone, or by migration progress alone", async () => {
    for (const set of [{ quoteReserve: 85_000_000_000n }, { migrationProgress: 1 }]) {
      const w = qslWorld();
      Object.assign(ps(w), set);
      w.mintOpts.extensions[1] = ext.transferHook(null, null);
      const r = await run(w);
      expect([r.graduated, r.level]).toEqual([true, 2]);
    }
  });
});

// --------------------------------------------------------- the DBC config ---

describe("C1.11 to C1.16: the DBC config", () => {
  const lockedVesting = (w: QslWorld): Record<string, unknown> => cfg(w)["lockedVestingConfig"] as Record<string, unknown>;
  const baseFee = (w: QslWorld): Record<string, unknown> => (cfg(w)["poolFees"] as { baseFee: Record<string, unknown> }).baseFee;
  const dynamicFee = (w: QslWorld): Record<string, unknown> => (cfg(w)["poolFees"] as { dynamicFee: Record<string, unknown> }).dynamicFee;
  it.each<[string, string, (w: QslWorld) => void]>([
    ["transfer_hook_program", "C1.11", (w) => void (w.config["transferHookProgram"] = key("qsl/evil-hook"))],
    ["fee_claimer", "C1.11", (w) => void (cfg(w)["feeClaimer"] = key("qsl/claimer"))],
    ["leftover_receiver", "C1.11", (w) => void (cfg(w)["leftoverReceiver"] = key("qsl/claimer"))],
    ["token_type 0 (SPL Token)", "C1.11", (w) => void (cfg(w)["tokenType"] = 0)],
    ["token_update_authority 0", "C1.11", (w) => void (cfg(w)["tokenUpdateAuthority"] = 0)],
    ["migration_option 0", "C1.11", (w) => void (cfg(w)["migrationOption"] = 0)],
    ["collect_fee_mode 1", "C1.11", (w) => void (cfg(w)["collectFeeMode"] = 1)],
    ["activation_type 0", "C1.11", (w) => void (cfg(w)["activationType"] = 0)],
    ["creator_trading_fee_percentage 50", "C1.11", (w) => void (cfg(w)["creatorTradingFeePercentage"] = 50)],
    ["fixed_token_supply_flag 1", "C1.11", (w) => void (cfg(w)["fixedTokenSupplyFlag"] = 1)],
    ["pool_creation_fee 1", "C1.11", (w) => void (cfg(w)["poolCreationFee"] = 1n)],
    ["enable_first_swap_with_min_fee 1", "C1.11", (w) => void (cfg(w)["enableFirstSwapWithMinFee"] = 1)],
    ["token_decimal 9", "C1.11", (w) => void (cfg(w)["tokenDecimal"] = 9)],
    ["migration_quote_threshold + 1", "C1.11", (w) => void (cfg(w)["migrationQuoteThreshold"] = 85_000_000_001n)],
    ["migration_fee_option 3", "C1.11", (w) => void (cfg(w)["migrationFeeOption"] = 3)],
    ["partner_permanent_locked 99%", "C1.12", (w) => void (cfg(w)["partnerPermanentLockedLiquidityPercentage"] = 99)],
    ["partner_liquidity 1%", "C1.12", (w) => void (cfg(w)["partnerLiquidityPercentage"] = 1)],
    ["creator_liquidity 1%", "C1.12", (w) => void (cfg(w)["creatorLiquidityPercentage"] = 1)],
    ["creator_permanent_locked 1%", "C1.12", (w) => void (cfg(w)["creatorPermanentLockedLiquidityPercentage"] = 1)],
    ["partner liquidity vesting", "C1.12", (w) => void ((cfg(w)["partnerLiquidityVestingInfo"] as Record<string, unknown>)["isInitialized"] = 1)],
    ["creator liquidity vesting", "C1.12", (w) => void ((cfg(w)["creatorLiquidityVestingInfo"] as Record<string, unknown>)["isInitialized"] = 1)],
    ["migration_fee_percentage 1", "C1.13", (w) => void (cfg(w)["migrationFeePercentage"] = 1)],
    ["creator_migration_fee_percentage 1", "C1.13", (w) => void (cfg(w)["creatorMigrationFeePercentage"] = 1)],
    ["locked vesting amount_per_period", "C1.14", (w) => void (lockedVesting(w)["amountPerPeriod"] = 1n)],
    ["locked vesting cliff_duration", "C1.14", (w) => void (lockedVesting(w)["cliffDurationFromMigrationTime"] = 1n)],
    ["locked vesting frequency", "C1.14", (w) => void (lockedVesting(w)["frequency"] = 1n)],
    ["locked vesting number_of_period", "C1.14", (w) => void (lockedVesting(w)["numberOfPeriod"] = 1n)],
    ["locked vesting cliff_unlock_amount", "C1.14", (w) => void (lockedVesting(w)["cliffUnlockAmount"] = 1n)],
    ["quote mint not wSOL", "C1.15", (w) => void (cfg(w)["quoteMint"] = key("qsl/usd"))],
    ["base fee 11% after its schedule", "C1.16", (w) => void (baseFee(w)["cliffFeeNumerator"] = 110_000_000n)],
    [
      "base fee 9% plus a dynamic fee of up to 1.1%",
      "C1.16",
      (w) => {
        baseFee(w)["cliffFeeNumerator"] = 90_000_000n;
        // ceil((maxVolatilityAccumulator x binStep)^2 x variableFeeControl / 10^11) = 10^10 x 1.1 x 10^8 / 10^11 = 11,000,000 (1.1%).
        Object.assign(dynamicFee(w), { initialized: 1, maxVolatilityAccumulator: 100_000, binStep: 1, variableFeeControl: 110_000_000 });
      },
    ],
    [
      "a fee schedule longer than the commit window",
      "C1.16",
      (w) => {
        baseFee(w)["firstFactor"] = 10;
        baseFee(w)["secondFactor"] = 60n; // 600 s > open_delay_secs 300
      },
    ],
    ["a base fee mode that is not a schedule", "C1.16", (w) => void (baseFee(w)["baseFeeMode"] = 2)],
  ])("%s: %s fails", async (_, id, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, id), check(r, id).detail).toBe("fail");
    expect(r.level).toBe(0);
  });

  it("C1.16: a dynamic fee within the ceiling passes (9% + up to 1%: exactly 10%)", async () => {
    const w = qslWorld();
    baseFee(w)["cliffFeeNumerator"] = 90_000_000n;
    Object.assign(dynamicFee(w), { initialized: 1, maxVolatilityAccumulator: 100_000, binStep: 1, variableFeeControl: 100_000_000 }); // exactly 1%
    const r = await run(w);
    expect(check(r, "C1.16").detail).toMatch(/900 bps .* at most 100 bps dynamic/);
    expect((await run(w)).level).toBe(2);
  });

  it("a config that is missing, foreign or not a ConfigWithTransferHook fails C1.11 to C1.16", async () => {
    for (const mutate of [
      (w: QslWorld) => del(w, w.pdas.dbcConfig),
      (w: QslWorld) => reown(w, w.pdas.dbcConfig, PROGRAM_IDS.launchpad),
      (w: QslWorld) => patch(w, w.pdas.dbcConfig, (d) => void d.set(idlCodecs().dbc.accountDiscriminator("PoolConfig"), 0)),
    ]) {
      const w = qslWorld();
      mutate(w);
      const r = await run(w);
      for (const id of ["C1.11", "C1.12", "C1.13", "C1.14", "C1.15", "C1.16"]) expect([id, statusOf(r, id)]).toEqual([id, "fail"]);
    }
  });
});

// ------------------------------------------------------ launch and pool ---

describe("C1.17 to C1.19: the launch and the pool", () => {
  it.each<[string, string, (w: QslWorld) => void]>([
    ["Configured, not Live", "C1.17", (w) => void (w.launchState.status = 0)],
    ["version 3", "C1.17", (w) => patch(w, w.launch, (d) => void (d[8] = 3))],
    ["586 bytes", "C1.17", (w) => patch(w, w.launch, (d) => concatBytes([d, new Uint8Array(1)]))],
    ["missing", "C1.17", (w) => del(w, w.launch)],
    ["owned by another program", "C1.17", (w) => reown(w, w.launch, PROGRAM_IDS.hook)],
    ["another account's discriminator", "C1.17", (w) => patch(w, w.launch, (d) => void d.set(fromHex(QSL1.CERTIFICATE.DISCRIMINATOR), 0))],
    ["not at PDA(launch, creator, seed)", "C1.18", (w) => patch(w, w.launch, (d) => void (d[14]! ^= 1))],
    ["base_mint", "C1.18", (w) => void (w.launchState.baseMint = key("qsl/other-mint"))],
    ["pool", "C1.18", (w) => void (w.launchState.pool = key("qsl/other-pool"))],
    ["dbc_config", "C1.18", (w) => void (w.launchState.dbcConfig = key("qsl/other-config"))],
    ["launch_authority", "C1.18", (w) => void (w.launchState.launchAuthority = key("qsl/other-authority"))],
    ["batch_authority", "C1.18", (w) => void (w.launchState.batchAuthority = key("qsl/other-batch"))],
    ["the certificate's creator", "C1.18", (w) => void (w.cert.creator = key("qsl/other-creator"))],
    ["the certificate's params_hash", "C1.18", (w) => void (w.cert.paramsHash = sha256(utf8("other params")))],
    ["token_decimal", "C1.18", (w) => void (w.launchState.tokenDecimal = 9)],
    ["migration threshold", "C1.18", (w) => void (w.launchState.migrationQuoteThreshold += 1n)],
    ["migration fee option", "C1.18", (w) => void (w.launchState.migrationFeeOption = 3)],
    ["platform fee", "C1.18", (w) => void (w.launchState.platformFeeBps = 500)],
    ["recipients", "C1.18", (w) => void (w.launchState.recipients[1]!.bps = 2_999)],
    ["p2p lock", "C1.18", (w) => void (w.launchState.p2pLocked = 1)],
    ["launch_ts", "C1.18", (w) => void (w.launchState.launchTs += 1n)],
    ["execute_end_ts", "C1.18", (w) => void (w.launchState.executeEndTs += 1n)],
    ["the certificate's snipe-shield end is not its execute end", "C1.18", (w) => void (w.cert.snipeShieldEndTs -= 1n)],
    ["guard_end_ts", "C1.18", (w) => void (w.launchState.guardEndTs += 1n)],
    ["pool missing", "C1.19", (w) => del(w, dbcPoolAddress(w.pdas.dbcConfig, w.mint))],
    ["pool owned by another program", "C1.19", (w) => reown(w, dbcPoolAddress(w.pdas.dbcConfig, w.mint), PROGRAM_IDS.launchpad)],
    ["pool's config", "C1.19", (w) => void (ps(w)["config"] = key("qsl/other-config"))],
    ["pool's creator", "C1.19", (w) => void (ps(w)["creator"] = key("qsl/other-creator"))],
    ["pool's base mint", "C1.19", (w) => void (ps(w)["baseMint"] = key("qsl/other-mint"))],
    ["pool's base vault", "C1.19", (w) => void (ps(w)["baseVault"] = key("qsl/other-vault"))],
    ["pool's quote vault", "C1.19", (w) => void (ps(w)["quoteVault"] = key("qsl/other-vault"))],
    [
      "a pool that is not the DBC PDA",
      "C1.19",
      (w) => {
        const real = dbcPoolAddress(w.pdas.dbcConfig, w.mint);
        w.cert.pool = key("qsl/fake-pool");
        w.patches.push(() => w.conn.set(w.cert.pool, w.conn.get(real)!));
      },
    ],
  ])("%s: %s fails", async (_, id, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, id), check(r, id).detail).toBe("fail");
    expect(r.level).toBe(0);
  });
});

// ----------------------------------------------------------- fee routing ---

describe("C1.20: fee routing", () => {
  const R = (w: QslWorld) => w.cert.recipients;
  it.each<[string, (w: QslWorld) => void]>([
    ["platform fee 5,001 bps", (w) => void (w.cert.platformFeeBps = 5_001)],
    ["shares totalling 9,000", (w) => void (R(w)[1]!.bps = 2_000)],
    ["a used slot with a zero share", (w) => void (R(w)[2] = { wallet: key("qsl/r3"), bps: 0 })],
    [
      "a zero key with a share",
      (w) => {
        R(w)[1]!.bps = 2_999;
        R(w)[2] = { wallet: PublicKey.default, bps: 1 };
      },
    ],
    ["a recipient twice", (w) => void (R(w)[1]!.wallet = R(w)[0]!.wallet)],
    ["the launch authority", (w) => void (R(w)[0]!.wallet = w.pdas.launchAuthority)],
    ["the batch authority", (w) => void (R(w)[1]!.wallet = w.pdas.batchAuthority)],
    ["no recipient", (w) => void (w.cert.recipients = R(w).map(() => ({ wallet: PublicKey.default, bps: 0 })))],
    ["an empty slot before a used one", (w) => void (w.cert.recipients = [{ wallet: PublicKey.default, bps: 0 }, R(w)[0]!, R(w)[1]!, { wallet: PublicKey.default, bps: 0 }])],
  ])("%s: fails", async (_, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, "C1.20"), check(r, "C1.20").detail).toBe("fail");
  });

  it("four recipients at the 50% platform cap pass", async () => {
    const w = qslWorld();
    const four = [1, 2, 3, 4].map((i) => ({ wallet: key(`qsl/four/${i}`), bps: 2_500 }));
    w.cert.recipients = four.map((r) => ({ ...r }));
    w.launchState.recipients = four.map((r) => ({ ...r }));
    w.launchState.recipientCount = 4;
    w.cert.platformFeeBps = 5_000;
    w.launchState.platformFeeBps = 5_000;
    expect((await run(w)).level).toBe(2);
  });
});

// ------------------------------------------------------- the hook policy ---

describe("C1.21 and C1.22: the hook policy and account list", () => {
  const policy = (w: QslWorld): PublicKey => hookPolicyAddress(w.mint);
  it.each<[string, string, (w: QslWorld) => void]>([
    ["policy missing", "C1.21", (w) => del(w, policy(w))],
    ["owned by the launchpad", "C1.21", (w) => reown(w, policy(w), PROGRAM_IDS.launchpad)],
    ["280 bytes (not 279 + its rules length)", "C1.21", (w) => patch(w, policy(w), (d) => concatBytes([d, new Uint8Array(1)]))],
    ["another discriminator", "C1.21", (w) => patch(w, policy(w), (d) => void d.set(fromHex(QSL1.CERTIFICATE.DISCRIMINATOR), 0))],
    ["version 1", "C1.21", (w) => void (w.policy.version = 1)],
    ["version 3", "C1.21", (w) => void (w.policy.version = 3)],
    ["the version-1 layout (275 bytes) under a version-4 certificate", "C1.21", (w) => void (w.policy.rules = null)],
    ["launch rules the certificate does not bind", "C1.21", (w) => void (w.policy.rules = Uint8Array.of(1, 2, 3))],
    ["a rules length past the account", "C1.21", (w) => patch(w, policy(w), (d) => void new DataView(d.buffer).setUint32(275, 9, true))],
    ["mint", "C1.21", (w) => void (w.policy.mint = key("qsl/other-mint"))],
    ["pool", "C1.21", (w) => void (w.policy.pool = key("qsl/other-pool"))],
    ["base vault", "C1.21", (w) => void (w.policy.baseVault = key("qsl/other-vault"))],
    ["launch_ts", "C1.21", (w) => void (w.policy.launchTs += 1n)],
    ["guard_end_ts", "C1.21", (w) => void (w.policy.guardEndTs += 1n)],
    [
      "a guard over 72 hours",
      "C1.21",
      (w) => {
        const end = w.cert.launchedAt + 259_201n;
        w.cert.guardEndTs = end;
        w.launchState.guardEndTs = end;
        w.policy.guardEndTs = end;
      },
    ],
    ["a batch not executed, the shield ended early", "C1.21", (w) => void (w.launchState.executed = 0)],
    ["an executed batch, the shield ending at execute_end_ts", "C1.21", (w) => void (w.policy.snipeShieldEndTs = w.launchState.executeEndTs)],
    ["an executed batch, the shield ending before commit_end_ts", "C1.21", (w) => void (w.policy.snipeShieldEndTs = w.launchState.commitEndTs - 1n)],
    [
      "a snipe shield past launch_ts + 3,600",
      "C1.21",
      (w) => {
        const end = w.cert.launchedAt + 3_601n;
        w.launchState.executed = 0;
        w.cert.snipeShieldEndTs = end;
        w.cert.executeEndTs = end;
        w.launchState.executeEndTs = end;
        w.policy.snipeShieldEndTs = end;
      },
    ],
    ["max_wallet", "C1.21", (w) => void (w.policy.maxWallet += 1n)],
    [
      "max_wallet below 0.1% of the supply",
      "C1.21",
      (w) => {
        w.cert.maxWallet = SUPPLY / 1_000n - 1n;
        w.policy.maxWallet = SUPPLY / 1_000n - 1n;
      },
    ],
    ["max_buy", "C1.21", (w) => void (w.policy.maxBuy += 1n)],
    [
      "max_buy below 0.01% of the supply",
      "C1.21",
      (w) => {
        w.cert.maxBuy = SUPPLY / 10_000n - 1n;
        w.policy.maxBuy = SUPPLY / 10_000n - 1n;
      },
    ],
    ["p2p lock", "C1.21", (w) => void (w.policy.p2pLocked = 1)],
    ["a third exempt account", "C1.21", (w) => void (w.policy.exempt[2] = key("qsl/exempt"))],
    ["exempt accounts swapped", "C1.21", (w) => void (w.policy.exempt = [w.pdas.launchAuthority, w.pdas.batchAuthority, PublicKey.default, PublicKey.default])],
    ["account list missing", "C1.22", (w) => del(w, extraAccountMetaListAddress(w.mint))],
    ["account list with other bytes", "C1.22", (w) => void (w.metaList = Uint8Array.from(w.metaList, (b, i) => (i === 60 ? b ^ 1 : b)))],
    ["account list owned by another program", "C1.22", (w) => reown(w, extraAccountMetaListAddress(w.mint), PROGRAM_IDS.launchpad)],
  ])("%s: %s fails", async (_, id, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, id), check(r, id).detail).toBe("fail");
    expect(r.level).toBe(0);
  });

  it("a pending batch keeps the scheduled shield end; caps of 0 (off) pass", async () => {
    const w = qslWorld();
    w.launchState.executed = 0;
    w.policy.snipeShieldEndTs = w.cert.snipeShieldEndTs;
    w.cert.maxWallet = 0n;
    w.policy.maxWallet = 0n;
    w.cert.maxBuy = 0n;
    w.policy.maxBuy = 0n;
    const r = await run(w);
    expect(r.level).toBe(2);
    expect(r.info.find((i) => i.id === "info.firstTrade")?.status).toBe("warn"); // the fixture's pool has a swap
  });

  it("after graduation the policy is a SHOULD (a mismatch warns, the level stays) and the account list is not needed", async () => {
    const w = qslWorld();
    graduate(w, false);
    w.policy.maxBuy += 1n;
    del(w, extraAccountMetaListAddress(w.mint));
    const r = await run(w);
    expect([statusOf(r, "C1.21"), check(r, "C1.21").ok, statusOf(r, "C1.22"), r.level]).toEqual(["warn", true, "skip", 2]);
  });
});

// --------------------------------------------------------- after migration ---

describe("C1.23: the LP position after migration", () => {
  it("a DBC-created pool of (mint, wSOL) on the canonical config, permanently locked, held by the launch authority: level 2, with the pool's status and fee", async () => {
    const w = qslWorld();
    graduate(w, true);
    addLp(w);
    const r = await run(w);
    expect([r.level, r.migrated, statusOf(r, "C1.23")]).toEqual([2, true, "pass"]);
    expect(check(r, "C1.23").detail).toMatch(/canonical migration config/);
    expect(r.info.find((i) => i.id === "info.dammPool")?.status).toBe("pass");
    expect(r.info.find((i) => i.id === "info.dammFee")?.status).toBe("pass");
  });

  it.each<[string, (w: QslWorld) => void]>([
    ["no position", () => {}],
    ["no permanently locked liquidity", (w) => void (addLp(w).positionState["permanentLockedLiquidity"] = 0n)],
    ["vesting liquidity", (w) => void (addLp(w).positionState["vestedLiquidity"] = 1n)],
    ["a pool DBC did not create", (w) => void (addLp(w).poolState["creator"] = key("qsl/someone"))],
    ["a pool of other mints", (w) => void (addLp(w).poolState["tokenBMint"] = key("qsl/usd"))],
    ["two units in the NFT account", (w) => void (addLp(w).amount = 2n)],
    [
      "the NFT held by someone else",
      (w) => {
        const lp = addLp(w);
        w.patches.push(() => patch2(w, lp.nftAccount, (d) => void d.set(key("qsl/someone").toBytes(), 32)));
      },
    ],
    [
      "the canonical pool's position vests, even with a clean position in another pool",
      (w) => {
        addLp(w, { label: "a" }).positionState["vestedLiquidity"] = 1n;
        addLp(w, { canonical: false, label: "b" });
      },
    ],
  ])("%s: fails", async (_, mutate) => {
    const w = qslWorld();
    graduate(w, true);
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, "C1.23"), check(r, "C1.23").detail).toBe("fail");
    expect(r.level).toBe(0);
  });

  it("the stricter reading (§7.6): migration_progress 3 (CreatedPool) with is_migrated 0 requires the LP position too, and reads it", async () => {
    // Without a position: C1.23 fails (it was a not-applicable skip, level 2, when only is_migrated counted).
    const w = qslWorld();
    graduate(w, false);
    ps(w)["migrationProgress"] = 3;
    let r = await run(w);
    expect([r.graduated, r.migrated, statusOf(r, "C1.23"), check(r, "C1.23").ok, r.level, r.wouldBe]).toEqual([true, false, "fail", false, 0, 0]);
    expect(check(r, "C1.23").detail).toMatch(/^migration_progress is 3 \(CreatedPool\) although is_migrated is 0/);
    expect(r.blocking).toContain("C1.23");
    expect(w.conn.calls).toContain("getTokenAccountsByOwner");
    expect(r.info.find((i) => i.id === "info.graduation")).toBeUndefined();
    // With a permanently locked position: it passes, read the same way as after migration.
    const g = qslWorld();
    graduate(g, false);
    ps(g)["migrationProgress"] = 3;
    addLp(g);
    r = await run(g);
    expect([r.migrated, statusOf(r, "C1.23"), r.level]).toEqual([false, "pass", 2]);
    expect(g.conn.calls).toEqual(["getGenesisHash", "getMultipleAccountsInfoAndContext", "getMultipleAccountsInfoAndContext", "getTokenAccountsByOwner", "getMultipleAccountsInfoAndContext", "getMultipleAccountsInfoAndContext"]);
    // Graduated with migration_progress 1 or 2 (not CreatedPool): still a not-applicable skip.
    for (const progress of [1, 2]) {
      const p = qslWorld();
      graduate(p, false);
      ps(p)["migrationProgress"] = progress;
      r = await run(p);
      expect([progress, statusOf(r, "C1.23"), check(r, "C1.23").ok, r.level]).toEqual([progress, "skip", true, 2]);
      expect(p.conn.calls).not.toContain("getTokenAccountsByOwner");
    }
  });

  it("a position only in a pool off the canonical config still counts (the verdict is taken on that pool)", async () => {
    const w = qslWorld();
    graduate(w, true);
    addLp(w, { canonical: false });
    const r = await run(w);
    expect([statusOf(r, "C1.23"), r.level]).toEqual(["pass", 2]);
    expect(check(r, "C1.23").detail).not.toMatch(/canonical/);
  });
});

/** Edit an account's bytes inside a patch (already built). */
function patch2(w: QslWorld, address: PublicKey, edit: (d: Uint8Array) => void): void {
  const a = w.conn.get(address)!;
  const d = Uint8Array.from(a.data);
  edit(d);
  w.conn.set(address, { ...a, data: d });
}

// ------------------------------------------------------------- level 2 ---

describe("C2.2 to C2.8: the post-quantum attestation and the record", () => {
  it.each<[string, string, (w: QslWorld) => void]>([
    ["attestation missing", "C2.2", (w) => del(w, ATTESTATION)],
    ["an empty (burn-only) attestation", "C2.2", (w) => void (w.attestation = fromHex(LMS.burnOnly.emptyAttestation))],
    ["owned by another program", "C2.2", (w) => reown(w, ATTESTATION, PROGRAM_IDS.hook)],
    ["2,709 bytes", "C2.2", (w) => patch(w, ATTESTATION, (d) => concatBytes([d, new Uint8Array(1)]))],
    ["another discriminator", "C2.2", (w) => patch(w, ATTESTATION, (d) => void d.set(fromHex(QSL1.LAUNCH.DISCRIMINATOR), 0))],
    ["version 1", "C2.2", (w) => patch(w, ATTESTATION, (d) => void (d[8] = 1))],
    ["version 2 (the 2,708-byte layout is version 3)", "C2.2", (w) => patch(w, ATTESTATION, (d) => void (d[8] = 2))],
    ["a rules_hash the certificate does not bind", "C2.2", (w) => patch(w, ATTESTATION, (d) => void (d[ATT.RULES_HASH]! ^= 1))],
    ["it names another launch", "C2.2", (w) => patch(w, ATTESTATION, (d) => void d.set(key("qsl/other-launch").toBytes(), 10))],
    ["the certificate names another identity", "C2.2", (w) => void (w.cert.pqIdentity = sha256(utf8("another identity")))],
    ["the launch names another identity", "C2.2", (w) => patch(w, w.launch, (d) => void d.set(sha256(utf8("another identity")), 553))],
    ["the certificate's leaf", "C2.2", (w) => void (w.cert.pqLeaf = 510)],
    ["the certificate's attested slot", "C2.2", (w) => void (w.cert.attestedSlot += 1n)],
    ["a signature length of 2,507", "C2.2", (w) => patch(w, ATTESTATION, (d) => void new DataView(d.buffer).setUint32(ATT.SIG_LEN, 2_507, true))],
    [
      "launched after the window",
      "C2.3",
      (w) => {
        const t = w.window.notAfter + 1n;
        w.cert.launchedAt = t;
        w.launchState.launchTs = t;
        w.policy.launchTs = t;
      },
    ],
    [
      "launched before the window",
      "C2.3",
      (w) => {
        const t = w.window.notBefore - 1n;
        w.cert.launchedAt = t;
        w.launchState.launchTs = t;
        w.policy.launchTs = t;
      },
    ],
    [
      "a signed window of 3,601 s",
      "C2.3",
      (w) => {
        w.window = { notBefore: w.window.notBefore, notAfter: w.window.notBefore + 3_601n };
        attestRecord(w, VECTOR_RECORD);
      },
    ],
    ["a stored message hash that is not the rebuilt message's", "C2.4", (w) => patch(w, ATTESTATION, (d) => void (d[ATT.MESSAGE_HASH + 12]! ^= 1))],
    [
      "the launch's params_hash (and the certificate's) not the signed one",
      "C2.4",
      (w) => {
        const other = sha256(utf8("other params"));
        w.cert.paramsHash = other;
        patch(w, w.launch, (d) => void d.set(other, 448));
      },
    ],
    ["identity missing", "C2.5", (w) => del(w, IDENTITY)],
    ["identity owned by another program", "C2.5", (w) => reown(w, IDENTITY, PROGRAM_IDS.hook)],
    ["identity of 197 bytes", "C2.5", (w) => void (w.identity = concatBytes([w.identity, new Uint8Array(1)]))],
    ["identity with another discriminator", "C2.5", (w) => void (w.identity = Uint8Array.from(w.identity, (b, i) => (i === 0 ? b ^ 1 : b)))],
    ["identity version 2", "C2.5", (w) => void (w.identity = Uint8Array.from(w.identity, (b, i) => (i === 8 ? 2 : b)))],
    ["a public key that does not hash to pq_identity", "C2.5", (w) => void (w.identity = Uint8Array.from(w.identity, (b, i) => (i === 40 ? b ^ 1 : b)))],
    ["the leaf's bit clear", "C2.5", (w) => void (w.identity = Uint8Array.from(w.identity, (b, i) => (i === 66 + (511 >> 3) ? b & ~0x80 : b)))],
    ["a flipped signature byte", "C2.6", (w) => patch(w, ATTESTATION, (d) => void (d[1_000]! ^= 1))],
    [
      "a signature that verifies at another leaf than the recorded one",
      "C2.6",
      (w) => {
        attestRecord(w, VECTOR_RECORD, 510); // signed at leaf 510...
        patch(w, ATTESTATION, (d) => void new DataView(d.buffer).setUint16(74, 509, true)); // ...recorded as 509
        w.cert.pqLeaf = 509;
        w.identity = Uint8Array.from(w.identity, (b, i) => (i === 66 + (509 >> 3) ? b | (1 << (509 & 7)) : b));
      },
    ],
    ["record missing", "C2.7", (w) => del(w, RECORD)],
    ["record owned by another program", "C2.7", (w) => reown(w, RECORD, PROGRAM_IDS.hook)],
    ["record bytes changed (its hash no longer matches)", "C2.7", (w) => void (w.record = Uint8Array.from(w.record, (b, i) => (i === w.record.length - 2 ? b ^ 1 : b)))],
    ["record version 2", "C2.7", (w) => void (w.record = Uint8Array.from(w.record, (b, i) => (i === 8 ? 2 : b)))],
    ["record with another discriminator", "C2.7", (w) => void (w.record = Uint8Array.from(w.record, (b, i) => (i === 0 ? b ^ 1 : b)))],
    [
      "the certificate names another record of the launch",
      "C2.7",
      (w) => {
        attestRecord(w, { ...VECTOR_RECORD, name: "Junk" }); // publishes a valid record of this launch...
        w.attestation = fromHex(LMS.accounts.attestation.data); // ...but the attestation signed the vector's
        w.recordText = { ...VECTOR_RECORD };
      },
    ],
    ["a signed record that breaks the record rules (an 11-byte symbol)", "C2.7", (w) => attestRecord(w, { ...VECTOR_RECORD, symbol: "ELEVENBYTES" })],
    ["the mint's name", "C2.8", (w) => void (w.mintMetadata = { ...recordMeta(), name: "Noised Vector Tokem" })],
    ["the mint's name with a byte-order mark", "C2.8", (w) => void (w.mintMetadata = { ...recordMeta(), name: `﻿${VECTOR_RECORD.name}` })],
    ["the mint's symbol", "C2.8", (w) => void (w.mintMetadata = { ...recordMeta(), symbol: "PHXX" })],
    ["a uri the record does not derive", "C2.8", (w) => void (w.mintMetadata = { ...recordMeta(), uri: "https://example.com/t.json" })],
    ["additional metadata", "C2.8", (w) => void (w.mintMetadata = { ...recordMeta(), additional: [["k", "v"]] })],
  ])("%s: %s fails", async (_, id, mutate) => {
    const w = qslWorld();
    mutate(w);
    const r = await run(w);
    expect(statusOf(r, id), check(r, id).detail).toBe("fail");
    expect(r.level).toBeLessThan(2);
  });

  it("C2.4 and C2.6 are independent: a wrong stored hash fails C2.4 while the signature over the rebuilt message still verifies, and a flipped signature fails only C2.6", async () => {
    let w = qslWorld();
    patch(w, ATTESTATION, (d) => void (d[ATT.MESSAGE_HASH + 12]! ^= 1));
    let r = await run(w);
    expect([statusOf(r, "C2.4"), statusOf(r, "C2.6")]).toEqual(["fail", "pass"]);
    w = qslWorld();
    patch(w, ATTESTATION, (d) => void (d[1_000]! ^= 1));
    r = await run(w);
    expect([statusOf(r, "C2.4"), statusOf(r, "C2.6"), r.level]).toEqual(["pass", "fail", 1]);
  });

  it("another leaf, an inline uri, an external uri: each signed and stored as the program would leave it is level 2", async () => {
    for (const [record, leaf, mode] of [
      [VECTOR_RECORD, 510, 0],
      [{ ...VECTOR_RECORD, flags: 1 }, 511, 1],
      [{ ...VECTOR_RECORD, flags: 2, uri: "https://example.com/t.json", doc: "" }, 511, 2],
    ] as const) {
      const w = qslWorld();
      attestRecord(w, record, leaf);
      const r = await run(w);
      expect([r.level, r.uriMode, notPassing(r)], `flags ${record.flags}`).toEqual([2, mode, ["C1.23:skip"]]);
      expect(r.info.find((i) => i.id === "info.uri")?.status).toBe(mode === 2 ? "warn" : "pass");
    }
  });
});

// ---------------------------------------------------------------- layouts ---

describe("QSL-1 §5 layouts against the programs (IDLs) and the Rust vectors", () => {
  it("the certificate written at §5.1's offsets decodes through the launchpad IDL to the same fields", () => {
    const w = qslWorld();
    const c = decodeCertificate(certificateAddress(w.mint), certificateBytes(w.cert));
    const f = w.cert;
    expect(c.version).toBe(f.version);
    expect([c.launch, c.baseMint, c.pool, c.dbcConfig, c.creator, c.metadata].map((k) => k.toBase58())).toEqual([f.launch, f.baseMint, f.pool, f.dbcConfig, f.creator, f.metadata].map((k) => k.toBase58()));
    expect([c.launchedAt, c.initialSupply, c.migrationQuoteThreshold, c.snipeShieldEndTs, c.executeEndTs, c.guardEndTs, c.maxWallet, c.maxBuy, c.attestedSlot]).toEqual([
      f.launchedAt,
      f.initialSupply,
      f.migrationQuoteThreshold,
      f.snipeShieldEndTs,
      f.executeEndTs,
      f.guardEndTs,
      f.maxWallet,
      f.maxBuy,
      f.attestedSlot,
    ]);
    expect([c.bump, c.tokenDecimal, c.checks, c.migrationFeeOption, c.platformFeeBps, c.policyVersion, c.pqLeaf, c.p2pLocked]).toEqual([
      f.bump,
      f.tokenDecimal,
      f.checks,
      f.migrationFeeOption,
      f.platformFeeBps,
      f.policyVersion,
      f.pqLeaf,
      f.p2pLocked === 1,
    ]);
    expect(c.recipients.map((r) => [r.wallet.toBase58(), r.bps])).toEqual(f.recipients.map((r) => [r.wallet.toBase58(), r.bps]));
    expect([toHex(c.paramsHash), toHex(c.pqIdentity)]).toEqual([toHex(f.paramsHash), toHex(f.pqIdentity)]);
    expect(idlCodecs().launchpad.accountSize("Certificate")).toBe(QSL1.CERTIFICATE.LEN);
    // Version 4: rules_hash at 487..519 (the last field), read back by readCertificate; version 3 is the first 487 bytes.
    const rulesHash = sha256(utf8("some rules"));
    const v4 = certificateBytes({ ...f, checks: 8_191, rulesHash });
    expect(toHex(decodeCertificate(certificateAddress(w.mint), v4).rulesHash)).toBe(toHex(rulesHash));
    expect([toHex(readCertificate(v4).rulesHash!), readCertificate(v4).checks]).toEqual([toHex(rulesHash), 8_191]);
    expect(toHex(v4.subarray(QSL1.CERTIFICATE.RULES_HASH_OFFSET))).toBe(toHex(rulesHash));
    const v3 = certificateBytes({ ...f, version: 3, rulesHash: null });
    const head = certificateBytes({ ...f, rulesHash: new Uint8Array(32) }).slice(0, QSL1.CERTIFICATE.V3_LEN);
    head[8] = 3;
    expect([v3.length, toHex(v3)]).toEqual([QSL1.CERTIFICATE.V3_LEN, toHex(head)]);
    expect(readCertificate(v3).rulesHash).toBeNull();
    expect(decodeCertificate(certificateAddress(w.mint), v3).version).toBe(3);
  });

  it("the launch completed at §5.2's offsets decodes through the IDL; the vector's create_launch fields are untouched", () => {
    const w = qslWorld();
    const l = decodeLaunch(w.launch, launchBytes(w.launchState));
    const f = w.launchState;
    expect(l.status).toBe("live");
    expect([l.dbcConfig, l.launchAuthority, l.batchAuthority, l.baseMint, l.pool, l.treasury].map((k) => k.toBase58())).toEqual([f.dbcConfig, f.launchAuthority, f.batchAuthority, f.baseMint, f.pool, f.treasury].map((k) => k.toBase58()));
    expect([l.platformFeeBps, l.recipientCount, l.tokenDecimal, l.migrationFeeOption, l.openDelaySecs, l.guardSecs, l.maxWalletBps, l.maxBuyBps]).toEqual([
      f.platformFeeBps,
      f.recipientCount,
      f.tokenDecimal,
      f.migrationFeeOption,
      f.openDelaySecs,
      f.guardSecs,
      f.maxWalletBps,
      f.maxBuyBps,
    ]);
    expect([l.migrationQuoteThreshold, l.batchWalletCap, l.batchTotalCap, l.launchTs, l.commitEndTs, l.executeEndTs, l.guardEndTs, l.totalCommitted, l.quoteSpent, l.tokensOut, l.tokensClaimed, l.quoteRefunded]).toEqual([
      f.migrationQuoteThreshold,
      f.batchWalletCap,
      f.batchTotalCap,
      f.launchTs,
      f.commitEndTs,
      f.executeEndTs,
      f.guardEndTs,
      f.totalCommitted,
      f.quoteSpent,
      f.tokensOut,
      f.tokensClaimed,
      f.quoteRefunded,
    ]);
    expect([l.executed, l.p2pLocked]).toEqual([true, false]);
    expect(l.recipients.map((r) => [r.wallet.toBase58(), r.bps])).toEqual(f.recipients.map((r) => [r.wallet.toBase58(), r.bps]));
    // What create_launch wrote (the Rust vector) is what the attestation's message is rebuilt from.
    const vector = decodeLaunch(w.launch, fromHex(LMS.accounts.launch.data));
    expect([l.creator.toBase58(), toHex(l.launchSeed), toHex(l.paramsHash), toHex(l.pqIdentity)]).toEqual([vector.creator.toBase58(), toHex(vector.launchSeed), toHex(vector.paramsHash), toHex(vector.pqIdentity)]);
    expect(idlCodecs().launchpad.accountSize("Launch")).toBe(QSL1.LAUNCH.LEN);
  });

  it("the hook policy v2 written at §5.6's offsets (rules length at 275, bytes from 279) is the hook IDL's encoding, byte for byte; version 1 is its first 275 bytes", () => {
    const w = qslWorld();
    for (const rules of [new Uint8Array(0), Uint8Array.from({ length: 286 }, (_, i) => (i * 7) & 0xff)]) {
      const f = { ...w.policy, rules };
      const bytes = policyBytes(f);
      expect(bytes).toHaveLength(QSL1.HOOK_POLICY.RULES_OFFSET + rules.length);
      expect(toHex(bytes)).toBe(toHex(accountBytes("hook", "HookPolicy", { ...f, p2pLocked: f.p2pLocked === 1 })));
      const p = idlCodecs().hook.decodeAccount<Record<string, unknown>>("HookPolicy", bytes);
      expect([p["version"], p["bump"], (p["mint"] as PublicKey).toBase58(), (p["pool"] as PublicKey).toBase58(), (p["baseVault"] as PublicKey).toBase58(), p["p2pLocked"]]).toEqual([
        f.version,
        f.bump,
        f.mint.toBase58(),
        f.pool.toBase58(),
        f.baseVault.toBase58(),
        false,
      ]);
      expect([p["launchTs"], p["snipeShieldEndTs"], p["guardEndTs"], p["maxWallet"], p["maxBuy"]]).toEqual([f.launchTs, f.snipeShieldEndTs, f.guardEndTs, f.maxWallet, f.maxBuy]);
      expect((p["exempt"] as PublicKey[]).map((k) => k.toBase58())).toEqual(f.exempt.map((k) => k.toBase58()));
      expect(toHex(p["rules"] as Uint8Array)).toBe(toHex(rules));
      const r = readHookPolicy(bytes);
      expect([r.version, r.rulesLen, toHex(r.rules!), r.maxBuy]).toEqual([2, rules.length, toHex(rules), f.maxBuy]);
    }
    const v1 = policyBytes({ ...w.policy, version: 1, rules: null });
    expect([v1.length, toHex(v1.subarray(8 + 2))]).toEqual([QSL1.HOOK_POLICY.V1_LEN, toHex(policyBytes({ ...w.policy, version: 1 }).subarray(10, 275))]);
    expect([readHookPolicy(v1).rules, readHookPolicy(v1).rulesLen]).toEqual([null, null]);
  });

  it("the Rust attestations (v3) re-encode byte for byte at §5.3's offsets and read as the IDL decodes them; v2 is v3 without rules_hash; the identity reads as §5.4 says", () => {
    const vector = fromHex(LMS.accounts.attestation.data);
    const a = readAttestation(vector);
    expect([a.version, a.leaf, a.slot, a.notBefore, a.notAfter, a.signatureLen, toHex(a.rulesHash!)]).toEqual([3, 511, 400_000_000n, BigInt(LMS.attestation.notBefore), BigInt(LMS.attestation.notAfter), 2_508, "00".repeat(32)]);
    expect(toHex(attestationBytes(a))).toBe(LMS.accounts.attestation.data);
    // programmable.json: an attestation binding launch rules.
    const withRules = fromHex(PROG.attestation.accountData);
    const b = readAttestation(withRules);
    expect([b.version, b.leaf, toHex(b.rulesHash!)]).toEqual([3, PROG.attestation.q, PROG.attestation.rulesHash]);
    expect(toHex(attestationBytes(b))).toBe(PROG.attestation.accountData);
    for (const [bytes, read] of [
      [vector, a],
      [withRules, b],
    ] as const) {
      const d = decodeAttestation(new PublicKey(bytes === vector ? LMS.accounts.attestation.address : PROG.attestation.address), bytes);
      expect([d.version, d.leaf, d.slot, d.notBefore, d.notAfter, toHex(d.rulesHash), toHex(d.messageHash), toHex(d.metadataHash), toHex(d.signature)]).toEqual([
        read.version,
        read.leaf,
        read.slot,
        read.notBefore,
        read.notAfter,
        toHex(read.rulesHash!),
        toHex(read.messageHash),
        toHex(read.metadataHash),
        toHex(read.signature),
      ]);
    }
    // Version 3 is the IDL's encoding of these fields (the signature a 2,508-byte vector): 2,708 bytes.
    expect(toHex(accountBytes("launchpad", "Attestation", { ...a, signature: a.signature }))).toBe(LMS.accounts.attestation.data);
    // Version 2 (2,676 bytes): the same fields without rules_hash, read back.
    const v2 = attestationBytes({ ...a, version: 2, rulesHash: null });
    const c = readAttestation(v2);
    expect([v2.length, c.rulesHash, c.version, c.leaf, c.slot, c.notAfter, c.signatureLen, toHex(c.messageHash), toHex(c.signature)]).toEqual([2_676, null, 2, 511, a.slot, a.notAfter, 2_508, toHex(a.messageHash), toHex(a.signature)]);
    const id = readIdentity(fromHex(LMS.accounts.identity.data));
    expect([id.version, toHex(id.publicKey), id.usedCount]).toEqual([1, LMS.identity.publicKey, 1]);
    expect(toHex(sha256(Uint8Array.of(0x21, ...id.publicKey)))).toBe(LMS.identity.identityId);
  });

  it("Appendix B's discriminators are the IDLs'; §5.7's account list is the canonical one", () => {
    const disc = (idl: "launchpad" | "hook", name: string): string => toHex(idlCodecs()[idl].accountDiscriminator(name));
    expect([disc("launchpad", "Certificate"), disc("launchpad", "Launch"), disc("launchpad", "Attestation"), disc("launchpad", "Identity"), disc("launchpad", "TokenMeta"), disc("hook", "HookPolicy")]).toEqual([
      QSL1.CERTIFICATE.DISCRIMINATOR,
      QSL1.LAUNCH.DISCRIMINATOR,
      QSL1.ATTESTATION.DISCRIMINATOR,
      QSL1.IDENTITY.DISCRIMINATOR,
      QSL1.TOKEN_META.DISCRIMINATOR,
      QSL1.HOOK_POLICY.DISCRIMINATOR,
    ]);
    expect(QSL1.META_LIST_HEX).toBe(toHex(expectedMetaListData()));
    expect(QSL1.META_LIST_HEX).toBe(toHex(metaListBytes()));
    expect(fromHex(QSL1.META_LIST_HEX)).toHaveLength(86);
  });

  it("§11.2's worked example, as the regenerated vectors now hold it: the record hash, the 221-byte message v3 (zero rules hash) and its signature", () => {
    // QSL-1 §11.2 still prints the retired 189-byte v2 message (hash 530614f8..., leaf 108); metadata.json was regenerated for
    // message v3, so the example is checked here against the vector itself.
    const m = readJson<{
      cases: { metadataHash: string }[];
      attestation: { message: string; messageHash: string; publicKey: string; signature: string; q: number; rulesHash: string; notBefore: number; notAfter: number };
    }>("./vectors/metadata.json");
    const c0 = m.cases[0]!;
    expect(c0.metadataHash).toBe("5df054afab0520c59bfe7360f870022fd3a454cb206bbfbca553943cd1110153");
    expect(toHex(metadataHashV2({ name: "Phalanx Cryo Token", symbol: "PHXCR", flags: 0, uri: "", doc: "" }))).toBe(c0.metadataHash);
    const msg = fromHex(m.attestation.message);
    expect(msg).toHaveLength(QSL1.ATTESTATION.MESSAGE_LEN);
    expect(new TextDecoder().decode(msg.subarray(0, 13))).toBe("PHX-ATTEST-V3");
    expect(toHex(sha256(msg))).toBe(m.attestation.messageHash);
    expect(m.attestation.messageHash).toBe("cbdeb689eacb8acaeb4b9dc4c442b81324194f4a0e8fa7e965bc75315e778ca8");
    expect(lmsVerify(fromHex(m.attestation.publicKey), msg, fromHex(m.attestation.signature))).toBe(m.attestation.q);
    expect(m.attestation.q).toBe(958);
    expect(toHex(sha256(Uint8Array.of(0x21, ...fromHex(m.attestation.publicKey))))).toBe("bc0127aba7c34b308ec1790388faa7cf2b58cc3ce2ed3e4b8875678b69096942");
    // The rules hash (zero: no rules) at 173..205, then the window: not_before 1,767,225,600 and not_after 3,600 s later.
    expect(toHex(msg.subarray(173, 205))).toBe(m.attestation.rulesHash);
    expect(toHex(msg.subarray(205))).toBe(toHex(concatBytes([u64le(1_767_225_600n), u64le(1_767_229_200n)])));
    expect(attestationAddress(new PublicKey(LMS.attestation.launch)).toBase58()).toBe(LMS.accounts.attestation.address);
  });
});

// ------------------------------------------------------------------ badge ---

/** Appendix A.3: what no app may say. */
const FORBIDDEN = [/quantum-proof/i, /quantum-safe/i, /unhackable/i, /can'?t lose value/i, /safe investment/i, /risk-free/i, /verified (project|team)/i, /\bofficial\b/i, /trusted creator/i, /\baudited\b/i, /\bprivate\b/i, /\banonymous\b/i];

describe("qslBadge (Appendix A)", () => {
  it("level 2: 'QSL-1 · Quantum-attested' with the standard's lines and the required ones", async () => {
    const r = await run(qslWorld());
    const b = qslBadge(r);
    expect([b.label, b.name, b.title, b.tone, b.showOnTradeScreen, b.mint]).toEqual(["QSL-1 L2", "Quantum-attested", "QSL-1 · Quantum-attested", "positive", true, r.mint.toBase58()]);
    expect(b.summary).toBe("Launched with its creator's quantum-resistant signature, checked just now.");
    expect(b.lines[0]).toBe(b.summary);
    expect(b.lines).toContain("Nobody can mint more, freeze your tokens, change its name or pull its liquidity.");
    expect(b.lines).toContain("No one could have launched it with different details or at a different time.");
    expect(b.required).toEqual([
      "This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams.",
      "The token itself sits in normal wallets, which are not quantum-resistant.",
    ]);
    expect(b.lines.slice(-2)).toEqual(b.required);
    expect(b.lines).not.toContain("Its icon link was chosen by the creator; what it shows can change.");
  });

  it("level 1: 'QSL-1 · No-rug'; an external link adds its line", async () => {
    const w = qslWorld();
    patch(w, ATTESTATION, (d) => void (d[1_000]! ^= 1));
    const b = qslBadge(await run(w));
    expect([b.label, b.title, b.summary, b.required]).toEqual([
      "QSL-1 L1",
      "QSL-1 · No-rug",
      "Nobody can mint more, freeze your tokens, change its name or pull its liquidity.",
      ["This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams."],
    ]);
    expect(b.lines).toContain("Selling is never blocked by the launch guard.");
    const x = qslWorld();
    attestRecord(x, { ...VECTOR_RECORD, flags: 2, uri: "https://example.com/t.json", doc: "" });
    expect(qslBadge(await run(x)).lines).toContain("Its icon link was chosen by the creator; what it shows can change.");
  });

  it("a candidate: 'QSL-1 candidate: not final yet', never on a mainnet trade screen; shown on devnet with why", async () => {
    const w = qslWorld();
    w.upgradeAuthority.launchpad = key("qsl/upgrader");
    let b = qslBadge(await run(w));
    expect([b.label, b.name, b.title, b.tone, b.showOnTradeScreen]).toEqual(["QSL-1 candidate", "Quantum-attested", "QSL-1 candidate: not final yet", "caution", false]);
    expect(b.summary).toBe("Meets every check for Level 2 (Quantum-attested), but no level is given yet.");
    expect(b.lines).toContain("Noised's programs can still be updated by their team; levels are given only once they are final.");
    w.genesisHash = GENESIS_HASHES.devnet;
    b = qslBadge(await run(w));
    expect(b.showOnTradeScreen).toBe(true);
    expect(b.lines).toContain("This is Solana devnet, a test network; levels are given only on mainnet.");
  });

  it("a candidate on a cluster known not to be mainnet ('other') may be on a trade screen; on an unknown cluster (the RPC may be mainnet) it may not (A.1)", async () => {
    const o = qslWorld();
    o.genesisHash = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";
    let r = await run(o);
    let b = qslBadge(r);
    expect([r.cluster, r.candidate, b.label, b.showOnTradeScreen]).toEqual(["other", true, "QSL-1 candidate", true]);
    expect(b.lines).toContain("This is not Solana mainnet; levels are given only on mainnet.");
    const u = qslWorld();
    u.build();
    u.conn.getGenesisHash = () => Promise.reject(new Error("no"));
    r = await checkQsl1(u.conn.asConnection(), u.mint);
    b = qslBadge(r);
    expect([r.cluster, r.candidate, b.label, b.title]).toEqual(["unknown", true, "QSL-1 candidate", "QSL-1 candidate: not final yet"]);
    expect(b.showOnTradeScreen).toBe(false);
    expect(b.lines).toContain("The network could not be confirmed as Solana mainnet; levels are given only on mainnet.");
    expect(b.lines).not.toContain("This is not Solana mainnet; levels are given only on mainnet.");
  });

  it("a certificate of a version this checker does not know is named (§10.2 rule 4), never 'not launched with Noised's protections'", async () => {
    const cases: [string, (w: QslWorld) => void, string, number][] = [
      // A version 5 that appends fields: a longer certificate fails C1.1 (length).
      ["version 5, 551 bytes", (w) => void ((w.cert.version = 5), patch(w, certificateAddress(w.mint), (d) => concatBytes([d, new Uint8Array(32)]))), "C1.1", 5],
      ["version 5 at 519 bytes", (w) => void (w.cert.version = 5), "C1.2", 5],
      ["version 2", (w) => void (w.cert.version = 2), "C1.2", 2],
    ];
    for (const [name, mutate, id, version] of cases) {
      const w = qslWorld();
      mutate(w);
      const r = await run(w);
      expect([name, r.certificateVersion, r.level, r.candidate, statusOf(r, id), r.blocking]).toEqual([name, version, 0, false, "fail", [id]]);
      expect(check(r, id).plain, name).toMatch(new RegExp(`^Its launch certificate is version ${version}, `));
      expect(r.reasons[0], name).toBe(check(r, id).plain);
      const b = qslBadge(r);
      expect([b.label, b.tone, b.showOnTradeScreen], name).toEqual(["Not QSL-1", "neutral", true]);
      expect(b.summary, name).toMatch(new RegExp(`^This token's launch certificate is version ${version}, `));
      expect(b.lines.join(" "), name).not.toMatch(/not launched with Noised/);
      if (version > 4) {
        expect(b.summary).toBe("This token's launch certificate is version 5, newer than this checker knows.");
        expect(b.lines).toEqual([b.summary, "An updated checker is needed to tell whether it meets QSL-1."]);
        expect(check(r, id).plain).toBe("Its launch certificate is version 5, newer than this checker knows: an updated checker is needed to check it.");
      } else expect(b.summary).toBe("This token's launch certificate is version 2, which this checker does not know.");
    }
    // Known versions (4, and 3 of the earlier generation), and no certificate at all, are unchanged.
    expect((await run(qslWorld())).certificateVersion).toBe(4);
    const old = qslWorld();
    legacy(old);
    expect((await run(old)).certificateVersion).toBe(3);
    // A known version at the other version's size is not "unknown": C1.2 says so.
    const sized = qslWorld();
    sized.cert.rulesHash = null; // version 4 at 487 bytes
    const s = await run(sized);
    expect([s.certificateVersion, s.blocking, s.reasons]).toEqual([4, ["C1.2"], ["Its launch certificate says version 4 but does not have that version's size."]]);
    expect(qslBadge(s).lines).toEqual(["This token does not meet the QSL-1 standard.", "Its launch certificate says version 4 but does not have that version's size."]);
    const none = qslWorld();
    del(none, certificateAddress(none.mint));
    const r = await run(none);
    expect([r.certificateVersion, qslBadge(r).summary]).toEqual([null, "This token was not launched with Noised's protections."]);
    // A launchpad account of the right length but another account's discriminator has no certificate version.
    const other = qslWorld();
    patch(other, certificateAddress(other.mint), (d) => void d.set(fromHex(QSL1.LAUNCH.DISCRIMINATOR), 0));
    expect((await run(other)).certificateVersion).toBeNull();
  });

  it("an unknown safety policy version is named in C1.2's sentence", async () => {
    const w = qslWorld();
    w.cert.policyVersion = 4;
    const r = await run(w);
    expect([statusOf(r, "C1.2"), r.certificateVersion, r.reasons]).toEqual(["fail", 4, ["Its launch certificate follows safety rules version 4, which this checker does not know."]]);
    expect(qslBadge(r).lines).toEqual(["This token does not meet the QSL-1 standard.", "Its launch certificate follows safety rules version 4, which this checker does not know."]);
  });

  it("not QSL-1: no certificate, or a failed level; never a partial badge", async () => {
    const w = qslWorld();
    del(w, certificateAddress(w.mint));
    let b = qslBadge(await run(w));
    expect([b.label, b.name, b.tone, b.summary, b.lines]).toEqual(["Not QSL-1", null, "neutral", "This token was not launched with Noised's protections.", ["This token was not launched with Noised's protections."]]);
    const f = qslWorld();
    f.mintOpts.mintAuthority = key("qsl/minter");
    b = qslBadge(await run(f));
    expect([b.label, b.lines]).toEqual(["Not QSL-1", ["This token does not meet the QSL-1 standard.", "Someone can still mint more of this token."]]);
    expect(() => qslBadge({} as QslResult)).toThrow(TypeError);
    expect(QSL1_LEVEL_NAMES).toEqual({ 1: "No-rug", 2: "Quantum-attested" });
  });

  it("no badge line, check sentence or reason says anything Appendix A.3 forbids; every sentence ends with a full stop", async () => {
    const worlds: QslWorld[] = [qslWorld()];
    const up = qslWorld();
    up.upgradeAuthority.launchpad = key("qsl/upgrader");
    worlds.push(up);
    const bad = qslWorld();
    bad.mintOpts.mintAuthority = key("qsl/minter");
    bad.mintOpts.freezeAuthority = key("qsl/freezer");
    patch(bad, ATTESTATION, (d) => void (d[1_000]! ^= 1));
    del(bad, hookPolicyAddress(bad.mint));
    worlds.push(bad);
    const none = qslWorld();
    del(none, certificateAddress(none.mint));
    worlds.push(none);
    const titles: string[] = [];
    const sentences: string[] = [];
    for (const w of worlds) {
      const r = await run(w);
      const b = qslBadge(r);
      titles.push(b.title, ...r.checks.map((c) => c.title), ...r.info.map((i) => i.title));
      sentences.push(b.summary, ...b.lines, ...r.reasons, ...r.checks.map((c) => c.plain), ...r.info.map((i) => i.plain));
    }
    for (const t of [...titles, ...sentences]) for (const f of FORBIDDEN) expect(f.test(t), `${t} (${f})`).toBe(false);
    for (const s of sentences) expect(s, s).toMatch(/^[A-Z].*[.)]$/);
  });
});

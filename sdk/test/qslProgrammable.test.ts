/**
 * QSL-1 revision 0.4 §6.4: "Programmable" is a description shown next to the
 * level, not a level. The SDK's reference checker on the launch of the Rust
 * vectors' `programmable.json` (its attestation v3 binds the "typical"
 * rules; the LaunchRules record is the Rust bytes) and on autopilots whose
 * authorizations the vector identity signs (and the Rust vector's own kind-1
 * and kind-2 authorizations, freeze payload v2): the component checks P.R1
 * to P.R4 and P.G1 to P.G5, the warnings, the level that rules and
 * automation never raise or lower, the activation-time and freeze
 * `not_after` searches, the new accounts' layouts against the IDLs and the
 * Rust vectors, and the badge's "programmable" tag (Appendix A).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { AUTHORIZATION, CERTIFICATE, HOOK_POLICY, LAUNCH_RULES, PQ_IDENTITY, PROGRAM_IDS } from "../src/constants.js";
import { decodeAutopilot, decodeGraphRecord } from "../src/autopilot/accounts.js";
import { idlCodecs } from "../src/idl/index.js";
import { decodeLaunchRules } from "../src/launch/accounts.js";
import { authorizationAddress, autopilotAddress, launchRulesAddress, programDataAddress } from "../src/pda.js";
import { authorizationMessage } from "../src/pq/identity.js";
import { activationPayload, freezePayload } from "../src/programmable/autopilot/logic.js";
import { explainGraph } from "../src/programmable/graph/explain.js";
import { decompileGraph } from "../src/programmable/graph/model.js";
import { graphHash, rulesHash } from "../src/programmable/hash.js";
import { explainRules } from "../src/programmable/rules/explain.js";
import { qslBadge } from "../src/qsl/badge.js";
import { checkQsl1, evaluateQsl1, findActivateAt, findFreezeNotAfter, QSL1_CONDITION_IDS, QSL1_PROGRAMMABLE_CHECK_IDS, type QslAccount, type QslResult } from "../src/qsl/check.js";
import { QSL1, readAuthorization, readAutopilot, readGraphRecord, readLaunchRules } from "../src/qsl/layouts.js";
import { GENESIS_HASHES } from "../src/rpc/cluster.js";
import { key, readJson } from "./helpers.js";
import {
  addAutopilot,
  addVectorActivation,
  authorizationBytes,
  autopilotBytes,
  graphRecordBytes,
  launchRulesBytes,
  patch,
  PROG,
  programmableWorld,
  qslWorld,
  signAuthorization,
  TYPICAL_RULES,
  VECTOR_GRAPH,
  type QslWorld,
} from "./qslFixtures.js";
import { accountBytes } from "./world.js";

async function run(w: QslWorld, opts: Parameters<typeof checkQsl1>[2] = {}): Promise<QslResult> {
  w.build();
  return checkQsl1(w.conn.asConnection(), w.mint, opts);
}
const part = (r: QslResult, id: string) => {
  const c = r.programmable.checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no component check ${id}`);
  return c;
};
const check = (r: QslResult, id: string) => {
  const c = r.checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};
const statusOf = (r: QslResult, id: string): string => (id.startsWith("P.") ? part(r, id).status : check(r, id).status);
const notPassing = (r: QslResult): string[] => r.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
const partsNotPassing = (r: QslResult): string[] => r.programmable.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
/** Every failing level condition, then every failing component check. */
const failing = (r: QslResult): string[] => [...r.checks.filter((c) => c.status === "fail").map((c) => c.id), ...r.programmable.checks.filter((c) => c.status === "fail").map((c) => c.id)];
const kinds = (r: QslResult): string[] => r.programmable.warnings.map((w) => w.kind);
const R_IDS = ["P.R1", "P.R2", "P.R3", "P.R4"];
const G_IDS = ["P.G1", "P.G2", "P.G3", "P.G4", "P.G5"];
const notUsed = (ids: string[]): string[] => ids.map((id) => `${id}:skip`);
const del = (w: QslWorld, a: PublicKey): void => {
  w.patches.push(() => w.conn.delete(a));
};
const FREEZE_NOT_AFTER = BigInt(PROG.authorizations.freezeNotAfter);
const AI_GRAPH = fromHex(readJson<{ valid: { name: string; hex: string }[] }>("./vectors/programmable/graph.json").valid.find((v) => v.name === "AI-operated buyback")!.hex);

// ------------------------------------------------------------- layouts ---

describe("the programmable component's accounts at their offsets, against the IDLs and the Rust vectors", () => {
  it("discriminators and offsets: QSL1's are the IDLs', the SDK constants' and programmable.json's", () => {
    const disc = (idl: "launchpad" | "autopilot", name: string): string => toHex(idlCodecs()[idl].accountDiscriminator(name));
    expect([disc("launchpad", "LaunchRules"), disc("launchpad", "Authorization"), disc("autopilot", "Autopilot"), disc("autopilot", "GraphRecord")]).toEqual([
      QSL1.LAUNCH_RULES.DISCRIMINATOR,
      QSL1.AUTHORIZATION.DISCRIMINATOR,
      QSL1.AUTOPILOT.DISCRIMINATOR,
      QSL1.GRAPH_RECORD.DISCRIMINATOR,
    ]);
    expect([toHex(Uint8Array.from(LAUNCH_RULES.DISCRIMINATOR)), toHex(Uint8Array.from(AUTHORIZATION.DISCRIMINATOR)), toHex(Uint8Array.from(HOOK_POLICY.DISCRIMINATOR))]).toEqual([
      QSL1.LAUNCH_RULES.DISCRIMINATOR,
      QSL1.AUTHORIZATION.DISCRIMINATOR,
      QSL1.HOOK_POLICY.DISCRIMINATOR,
    ]);
    const p = (PROG as unknown as { parameters: Record<string, Record<string, unknown>> }).parameters;
    expect([p["discriminators"]!["launchRules"], p["discriminators"]!["authorization"], p["discriminators"]!["hookPolicy"]]).toEqual([QSL1.LAUNCH_RULES.DISCRIMINATOR, QSL1.AUTHORIZATION.DISCRIMINATOR, QSL1.HOOK_POLICY.DISCRIMINATOR]);
    expect([CERTIFICATE.ACCOUNT_LEN, CERTIFICATE.V3_ACCOUNT_LEN, CERTIFICATE.RULES_HASH_OFFSET, CERTIFICATE.CHECKS_OFFSET]).toEqual([QSL1.CERTIFICATE.LEN, QSL1.CERTIFICATE.V3_LEN, QSL1.CERTIFICATE.RULES_HASH_OFFSET, 187]);
    expect(p["certificate"]).toEqual({ accountLen: 519, allChecks: QSL1.ALL_CHECKS, checksOffset: 187, metadataOffset: 455, rulesBound: QSL1.RULES_BOUND, rulesHashOffset: 487, version: 4, withRules: QSL1.CHECKS_WITH_RULES });
    expect([PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN, PQ_IDENTITY.ATTESTATION_VERSION, PQ_IDENTITY.ATTEST_MESSAGE_LEN]).toEqual([QSL1.ATTESTATION.LEN, QSL1.ATTESTATION.VERSION, QSL1.ATTESTATION.MESSAGE_LEN]);
    expect(PQ_IDENTITY.ATTESTATION_OFFSETS).toEqual({ VERSION: 8, BUMP: 9, LAUNCH: 10, PQ_IDENTITY: 42, LEAF: 74, METADATA_HASH: 76, RULES_HASH: 108, MESSAGE_HASH: 140, SLOT: 172, NOT_BEFORE: 180, NOT_AFTER: 188, SIG_LEN: 196, SIGNATURE: 200 });
    expect([HOOK_POLICY.VERSION, HOOK_POLICY.RULES_LEN_OFFSET, HOOK_POLICY.RULES_OFFSET, HOOK_POLICY.BASE_LEN]).toEqual([QSL1.HOOK_POLICY.VERSION, QSL1.HOOK_POLICY.RULES_LEN_OFFSET, QSL1.HOOK_POLICY.RULES_OFFSET, QSL1.HOOK_POLICY.LEN]);
    expect(p["hookPolicy"]).toEqual({ rulesLenOffset: 275, rulesOffset: 279, space: "279 + rules length", version: 2 });
    expect([LAUNCH_RULES.FIXED_LEN, LAUNCH_RULES.VERSION, LAUNCH_RULES.MAX_RULES_LEN, LAUNCH_RULES.OFFSETS]).toEqual([QSL1.LAUNCH_RULES.FIXED_LEN, QSL1.LAUNCH_RULES.VERSION, QSL1.LAUNCH_RULES.MAX_RULES_LEN, { VERSION: 8, BUMP: 9, LAUNCH: 10, RULES_HASH: 42, LEN: 74, BYTES: 78 }]);
    expect(p["launchRules"]).toEqual({ fixedLen: 78, offsets: { bump: 9, bytes: 78, bytesLen: 74, launch: 10, rulesHash: 42, version: 8 }, version: 1 });
    expect([AUTHORIZATION.ACCOUNT_LEN, AUTHORIZATION.VERSION, AUTHORIZATION.KINDS.GRAPH_ACTIVATE, AUTHORIZATION.KINDS.GRAPH_FREEZE]).toEqual([QSL1.AUTHORIZATION.LEN, QSL1.AUTHORIZATION.VERSION, QSL1.AUTHORIZATION.KIND_ACTIVATE, QSL1.AUTHORIZATION.KIND_FREEZE]);
    expect(AUTHORIZATION.OFFSETS).toEqual({ VERSION: 8, BUMP: 9, LAUNCH: 10, PQ_IDENTITY: 42, KIND: 74, PAYLOAD_HASH: 75, MESSAGE_HASH: 107, UNIX_TIME: 139, SLOT: 147, LEAF: 155, SIG_LEN: 157, SIGNATURE: 161 });
    expect(p["authorization"]).toEqual({ accountLen: 2_669, offsets: { bump: 9, kind: 74, launch: 10, leaf: 155, messageHash: 107, payloadHash: 75, pqIdentity: 42, signature: 161, signatureLen: 157, slot: 147, unixTime: 139, version: 8 }, version: 1 });
    expect(idlCodecs().autopilot.accountSize("Autopilot")).toBe(QSL1.AUTOPILOT.LEN);
    // Freeze payload v2 (review 4, R5): the domain the Rust vectors name.
    expect((p["payloadDomains"] as Record<string, string>)["GRAPH_FREEZE"]).toBe(QSL1.FREEZE_DOMAIN);
  });

  it("the Rust LaunchRules records re-encode byte for byte at their offsets, decode through the IDL to the same fields, and sit at their PDA", () => {
    for (const r of PROG.rules) {
      const data = fromHex(r.accountData);
      const x = readLaunchRules(data);
      expect([x.version, x.bump, x.len, toHex(x.rulesHash), toHex(x.bytes)]).toEqual([1, r.bump, r.len, r.rulesHash, r.bytes]);
      expect(x.launch.toBase58()).toBe(PROG.launch.address);
      expect(toHex(launchRulesBytes(x))).toBe(r.accountData);
      expect(toHex(accountBytes("launchpad", "LaunchRules", x))).toBe(r.accountData);
      const d = decodeLaunchRules(new PublicKey(r.address), data);
      expect([d.version, d.bump, toHex(d.rulesHash), toHex(d.bytes)]).toEqual([x.version, x.bump, toHex(x.rulesHash), toHex(x.bytes)]);
      expect(launchRulesAddress(x.launch, x.rulesHash).toBase58()).toBe(r.address);
      expect(toHex(rulesHash(x.bytes))).toBe(r.rulesHash);
    }
  });

  it("the Rust Authorizations (kinds 1, 2, 3) re-encode byte for byte, decode through the IDL to the same fields, sign the 140-byte message and sit at their PDA; the freeze is payload v2 with not_after", () => {
    const autopilot = new PublicKey(PROG.authorizations.autopilot);
    const graph = fromHex(PROG.authorizations.graphHash);
    expect(autopilotAddress(new PublicKey(PROG.launch.address)).toBase58()).toBe(PROG.authorizations.autopilot);
    for (const c of PROG.authorizations.cases) {
      const data = fromHex(c.accountData);
      const a = readAuthorization(data);
      expect([a.version, a.bump, a.kind, a.leaf, a.signatureLen, toHex(a.payloadHash), toHex(a.messageHash), a.unixTime, a.slot]).toEqual([1, c.bump, c.kind, c.q, 2_508, c.payloadHash, c.messageHash, BigInt(PROG.launch.landsAt), BigInt(PROG.launch.slot)]);
      expect(toHex(a.signature)).toBe(c.signature);
      expect(toHex(authorizationBytes(a))).toBe(c.accountData);
      expect(toHex(accountBytes("launchpad", "Authorization", { ...a, signature: a.signature }))).toBe(c.accountData);
      const idl = idlCodecs().launchpad.decodeAccount<Record<string, unknown>>("Authorization", data);
      expect([idl["kind"], idl["leaf"], idl["unixTime"], toHex(idl["payloadHash"] as Uint8Array)]).toEqual([a.kind, a.leaf, a.unixTime, toHex(a.payloadHash)]);
      const message = authorizationMessage({ launch: a.launch, creator: new PublicKey(PROG.launch.creator), kind: a.kind, payloadHash: a.payloadHash });
      expect([toHex(message), toHex(sha256(message))]).toEqual([c.message, c.messageHash]);
      expect(authorizationAddress(a.launch, a.kind, a.payloadHash).toBase58()).toBe(c.address);
    }
    const [act, frz] = PROG.authorizations.cases;
    expect(toHex(activationPayload(autopilot, graph, BigInt(PROG.authorizations.activateAt)))).toBe(act!.payloadHash);
    expect(FREEZE_NOT_AFTER).toBe(1_767_229_200n);
    expect(toHex(freezePayload(autopilot, graph, FREEZE_NOT_AFTER))).toBe(frz!.payloadHash);
    expect(toHex(freezePayload(autopilot, graph, FREEZE_NOT_AFTER + 1n))).not.toBe(frz!.payloadHash);
    // The checker's search finds the vector's not_after from the authorization's landing up.
    expect(findFreezeNotAfter(autopilot, graph, fromHex(frz!.payloadHash), BigInt(PROG.launch.landsAt))).toEqual({ notAfter: FREEZE_NOT_AFTER, tried: Number(FREEZE_NOT_AFTER) - PROG.launch.landsAt + 1, truncated: false });
  });

  it("an Autopilot and a GraphRecord written at the standard's offsets decode through the autopilot IDL (and the SDK's decoders) to the same fields", () => {
    const w = qslWorld();
    const fx = addAutopilot(w, { pending: { graphHash: sha256(utf8("queued graph")) } });
    fx.fields.frozen = 1;
    fx.fields.operator = key("qsl/operator");
    fx.fields.pendingOperator = key("qsl/pending-operator");
    fx.fields.dammPool = key("qsl/damm-pool");
    fx.fields.authMarks[2] = { slot: 7n, key: key("qsl/revoke") };
    fx.fields.seq = 99n;
    const bytes = autopilotBytes(fx.fields);
    const d = decodeAutopilot(fx.address, bytes);
    const r = readAutopilot(bytes);
    const f = fx.fields;
    expect([d.version, d.bump, d.treasuryBump, d.frozen, d.seq, d.pendingActivateAt, d.activatedAt]).toEqual([f.version, f.bump, f.treasuryBump, true, 99n, f.pendingActivateAt, f.activatedAt]);
    expect([d.launch, d.mint, d.dammPool, d.pendingOperator, d.operator].map((k) => k.toBase58())).toEqual([f.launch, f.mint, f.dammPool, f.pendingOperator, f.operator].map((k) => k.toBase58()));
    expect([toHex(d.activeGraph), toHex(d.pendingGraph)]).toEqual([toHex(f.activeGraph), toHex(f.pendingGraph)]);
    expect(d.authMarks.map((m) => [m.slot, m.key.toBase58()])).toEqual(f.authMarks.map((m) => [m.slot, m.key.toBase58()]));
    expect([r.version, r.bump, r.treasuryBump, r.frozen, r.pendingActivateAt, r.activatedAt]).toEqual([f.version, f.bump, f.treasuryBump, 1, f.pendingActivateAt, f.activatedAt]);
    expect([r.launch, r.mint, r.dammPool, r.pendingOperator, r.operator].map((k) => k.toBase58())).toEqual([f.launch, f.mint, f.dammPool, f.pendingOperator, f.operator].map((k) => k.toBase58()));
    expect(r.authMarks.map((m) => [m.slot, m.key.toBase58()])).toEqual(f.authMarks.map((m) => [m.slot, m.key.toBase58()]));
    const g = fx.graph!;
    expect(toHex(g.data)).toBe(toHex(accountBytes("autopilot", "GraphRecord", { version: 1, bump: readGraphRecord(g.data).bump, launch: w.launch, graphHash: graphHash(g.bytes), bytes: g.bytes })));
    const rec = decodeGraphRecord(g.address, g.data);
    expect([toHex(rec.graphHash), toHex(rec.bytes), rec.launch.toBase58()]).toEqual([toHex(graphHash(VECTOR_GRAPH)), toHex(VECTOR_GRAPH), w.launch.toBase58()]);
    expect(toHex(graphRecordBytes({ ...readGraphRecord(g.data) }))).toBe(toHex(g.data));
  });
});

// --------------------------------------------------- no level 3 at all ---

describe("two levels; programmable is a description", () => {
  it("the condition ids are the levels' only; the component checks are their own list; nothing is level 3", async () => {
    expect(QSL1_CONDITION_IDS).toHaveLength(33);
    expect(QSL1_CONDITION_IDS.some((id) => id.startsWith("C3"))).toBe(false);
    expect(QSL1_PROGRAMMABLE_CHECK_IDS).toEqual([...R_IDS, ...G_IDS]);
    const w = programmableWorld();
    addAutopilot(w, { frozen: true });
    const r = await run(w);
    expect([r.level, r.wouldBe]).toEqual([2, 2]);
    expect(r.checks.map((c) => c.level).every((l) => l === 1 || l === 2)).toBe(true);
    expect(r.programmable.checks.map((c) => [c.id, c.component])).toEqual([...R_IDS.map((id) => [id, "rules"]), ...G_IDS.map((id) => [id, "autopilot"])]);
  });

  it("a token without rules or automation: present false, every component check not used, no warnings, level 2 with nothing blocking", async () => {
    const r = await run(qslWorld());
    expect([r.level, r.blocking, r.reasons]).toEqual([2, [], []]);
    expect(r.programmable).toMatchObject({ present: false, verified: true, warnings: [] });
    expect([r.programmable.rules, r.programmable.autopilot]).toEqual([undefined, undefined]);
    expect(partsNotPassing(r)).toEqual([...notUsed(R_IDS), ...notUsed(G_IDS)]);
    expect(r.programmable.checks.every((c) => c.ok)).toBe(true);
    // Deprecated 0.7 aliases.
    expect([r.components, r.rules, r.autopilot]).toEqual([{ rules: false, autopilot: false }, null, null]);
    expect(qslBadge(r).programmable).toBeNull();
  });
});

// ------------------------------------------------- component R: rules ---

describe("component R: launch rules (P.R1 to P.R4)", () => {
  it("the launch of programmable.json: level 2, programmable by its rules, explained in plain English, with what a holder should know", async () => {
    const w = programmableWorld();
    const r = await run(w);
    expect(notPassing(r)).toEqual(["C1.23:skip"]);
    expect(partsNotPassing(r)).toEqual(notUsed(G_IDS));
    expect([r.level, r.wouldBe, r.candidate, r.certificateVersion, r.blocking]).toEqual([2, 2, false, 4, []]);
    expect([r.programmable.present, r.programmable.verified]).toEqual([true, true]);
    expect(r.components).toEqual({ rules: true, autopilot: false });
    expect(check(r, "C1.3").detail).toMatch(/^checks = 8191: \(checks & 4,095\) = 4,095/);
    expect(part(r, "P.R1").detail).toBe(`certificate version 4 binds rules_hash ${TYPICAL_RULES.rulesHash}; checks = 8,191 (the twelve bits and RULES_BOUND)`);
    expect(part(r, "P.R3").detail).toMatch(/286 bytes hashing to rules_hash; the PXR1 verifier accepts them for the launch's 3600 s guard/);
    expect(check(r, "C2.6").detail).toMatch(/verifies at leaf 534/);
    expect(check(r, "C2.4").detail).toMatch(/221-byte message v3/);
    const rules = r.programmable.rules!;
    expect([rules.hashHex, rules.address.toBase58(), toHex(rules.bytes!), rules.verified]).toEqual([TYPICAL_RULES.rulesHash, TYPICAL_RULES.address, TYPICAL_RULES.bytes, true]);
    expect(rules.explain).toEqual(explainRules(fromHex(TYPICAL_RULES.bytes), { guardSecs: 3_600, tokenDecimals: 6 }));
    expect(rules.explain).toContain("Selling is always allowed: no rule can block a sell.");
    expect(r.rules).toBe(rules);
    expect(r.programmable.autopilot).toBeUndefined();
    // The typical rules: an anti-bot rule for the first 2 minutes, while the snipe shield (900 s) still keeps every buy
    // but the batch's away, so it can never refuse anything; a balance cap that also limits wallet-to-wallet transfers;
    // and a rule against wallet-to-wallet transfers through the bonding curve's program from 30 minutes on.
    expect(r.programmable.warnings.map((x) => [x.kind, x.rule, x.from, x.to])).toEqual([
      ["transferLimits", 2, 0, 3_600],
      ["transferLimits", 4, 1_800, 3_600],
      ["noOpRule", 0, null, null],
    ]);
    expect(r.programmable.warnings.map((x) => x.plain)).toEqual([
      "For the first hour, some wallet-to-wallet transfers are limited (rule 3).",
      "From 30 minutes to 1 hour after launch, some wallet-to-wallet transfers are limited (rule 5).",
      "Rule 1 can never block anything, so it does nothing.",
    ]);
    expect(w.conn.readConfigs.map((c) => c.keys)).toEqual([14, 8]);
  });

  it.each<[string, (w: QslWorld) => void, string[], number]>([
    [
      "a flipped byte of the record (the policy holding the same bytes): P.R3 alone",
      (w) => {
        const bytes = fromHex(TYPICAL_RULES.bytes);
        bytes[40]! ^= 1;
        w.rulesRecord!.data = Uint8Array.from(w.rulesRecord!.data, (b, i) => (i === 78 + 40 ? b ^ 1 : b));
        w.policy.rules = bytes;
      },
      ["P.R3"],
      2,
    ],
    ["a flipped byte of the record: P.R3, and the policy no longer holds the record's bytes (P.R4)", (w) => void (w.rulesRecord!.data = Uint8Array.from(w.rulesRecord!.data, (b, i) => (i === 100 ? b ^ 1 : b))), ["P.R3", "P.R4"], 2],
    ["the policy's rules are not the record's: P.R4 alone", (w) => void (w.policy.rules = fromHex(PROG.rules.find((x) => x.name === "largest")!.bytes)), ["P.R4"], 2],
    ["the policy's rules cut short: P.R4 alone", (w) => void (w.policy.rules = fromHex(TYPICAL_RULES.bytes).slice(0, 200)), ["P.R4"], 2],
    ["the record missing: P.R3 and P.R4 (nothing to compare)", (w) => del(w, new PublicKey(TYPICAL_RULES.address)), ["P.R3", "P.R4"], 2],
    ["the record owned by another program", (w) => w.patches.push(() => w.conn.set(new PublicKey(TYPICAL_RULES.address), { owner: PROGRAM_IDS.hook, data: w.rulesRecord!.data })), ["P.R3", "P.R4"], 2],
    ["the record's version 2", (w) => void (w.rulesRecord!.data = Uint8Array.from(w.rulesRecord!.data, (b, i) => (i === 8 ? 2 : b))), ["P.R3"], 2],
    ["the record's bump", (w) => void (w.rulesRecord!.data = Uint8Array.from(w.rulesRecord!.data, (b, i) => (i === 9 ? b - 1 : b))), ["P.R3"], 2],
    ["the record names another launch", (w) => void (w.rulesRecord!.data = Uint8Array.from(w.rulesRecord!.data, (b, i) => (i === 10 ? b ^ 1 : b))), ["P.R3"], 2],
    ["a record one byte longer than 78 + len", (w) => void (w.rulesRecord!.data = Uint8Array.from([...w.rulesRecord!.data, 0])), ["P.R3"], 2],
    ["rules the PXR1 verifier refuses for the launch's guard (guard_secs 60 < the rules' windows)", (w) => void (w.launchState.guardSecs = 60), ["P.R3"], 2],
    ["the policy v1 layout: C1.21 fails, so not even level 1", (w) => void (w.policy.rules = null), ["C1.21", "P.R4"], 0],
    [
      "the attestation's rules_hash flipped: C2.2 (not the certificate's), C2.4 and C2.6 (message v3 carries it), so P.R2",
      (w) => patch(w, new PublicKey(PROG.attestation.address), (d) => void (d[108]! ^= 1)),
      ["C2.2", "C2.4", "C2.6", "P.R2"],
      1,
    ],
    [
      "the certificate binds another rules hash (with RULES_BOUND): the attestation does not store it (C2.2, P.R2) and no record is at its address (P.R3, P.R4)",
      (w) => void (w.cert.rulesHash = sha256(utf8("other rules"))),
      ["C2.2", "P.R2", "P.R3", "P.R4"],
      1,
    ],
  ])("%s", async (_, mutate, failed, level) => {
    const w = programmableWorld();
    mutate(w);
    const r = await run(w);
    expect(failing(r)).toEqual(failed);
    // A failing component never lowers the level: only the level conditions do.
    expect([r.level, r.components.rules, r.programmable.present, r.programmable.verified, r.programmable.rules!.verified]).toEqual([level, false, true, false, false]);
    expect(kinds(r)[0]).toBe("rulesUnconfirmed");
    if (level === 2) expect([r.wouldBe, r.blocking]).toEqual([2, []]);
  });

  it("RULES_BOUND missing (checks 4,095 with a rules_hash) fails C1.3 and stops the run; P.R1 is not reached", async () => {
    const w = programmableWorld();
    w.cert.checks = 4_095;
    const r = await run(w);
    expect([statusOf(r, "C1.3"), r.level, r.blocking]).toEqual(["fail", 0, ["C1.3"]]);
    expect(check(r, "C1.3").detail).toBe("rules_hash is not zero but RULES_BOUND (4,096) is not set");
    expect(check(r, "C1.3").plain).toBe("Its launch certificate's checks do not match its launch rules.");
    expect([statusOf(r, "P.R1"), part(r, "P.R1").ok]).toEqual(["skip", false]);
    expect(r.programmable.present).toBe(false);
  });
});

// ---------------------------------------------- component G: autopilot ---

describe("component G: the autopilot (P.G1 to P.G5)", () => {
  it("an autopilot running a published graph, activated by the creator's identity: level 2, programmable by its automation; not frozen is a warning", async () => {
    const w = qslWorld();
    const fx = addAutopilot(w);
    const r = await run(w);
    expect(notPassing(r)).toEqual(["C1.23:skip"]);
    expect(partsNotPassing(r)).toEqual(notUsed(R_IDS));
    expect([r.level, r.wouldBe, r.candidate, r.blocking]).toEqual([2, 2, false, []]);
    expect([r.programmable.present, r.programmable.verified, r.components]).toEqual([true, true, { rules: false, autopilot: true }]);
    const a = r.programmable.autopilot!;
    expect([a.address.toBase58(), a.activeGraphHex, a.activateAt, a.authorization?.toBase58(), a.frozen, a.pending, a.verified, a.programFinal, a.operatorSteps, a.freezeNotAfter]).toEqual([
      fx.address.toBase58(),
      toHex(graphHash(VECTOR_GRAPH)),
      fx.activateAt,
      fx.activation.address.toBase58(),
      false,
      null,
      true,
      true,
      0,
      null,
    ]);
    expect(r.autopilot).toBe(a);
    expect(a.explain).toEqual(explainGraph(VECTOR_GRAPH, { tokenDecimals: 6 }));
    // Audit 4, A4-S: the account stores the activation (active_auth, active_activate_at): no search.
    expect(part(r, "P.G3").detail).toMatch(new RegExp(`\\(active_auth; kind 1, leaf 100, .*LMS signature verified at that leaf; payload_hash activates the running graph at active_activate_at ${fx.activateAt}$`));
    expect(part(r, "P.G4").detail).toMatch(/took effect 600 s after its authorization landed: the program allows that only for a first graph/);
    expect(part(r, "P.G5").detail).toMatch(/Noised Autopilot D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx is finalized/);
    expect(r.programmable.warnings).toEqual([
      { kind: "notFrozen", component: "autopilot", plain: "Its automation is not frozen: the creator can switch to a new plan, which takes over 72 hours after it is approved." },
    ]);
    expect(w.conn.calls).toEqual(["getGenesisHash", "getMultipleAccountsInfoAndContext", "getMultipleAccountsInfoAndContext", "getMultipleAccountsInfoAndContext"]);
    expect(w.conn.readConfigs.map((c) => c.keys)).toEqual([14, 7, 4]);
    expect((w.conn.readConfigs[2]!.config as { minContextSlot?: number }).minContextSlot).toBe(400_000_000);
  });

  it("rules and autopilot together: still level 2, both described", async () => {
    const w = programmableWorld();
    addAutopilot(w);
    const r = await run(w);
    expect([r.level, r.components, notPassing(r), partsNotPassing(r)]).toEqual([2, { rules: true, autopilot: true }, ["C1.23:skip"], []]);
    expect(kinds(r)).toEqual(["transferLimits", "transferLimits", "notFrozen", "noOpRule"]);
  });

  it("a frozen graph: its kind-2 authorization over freeze payload v2 is found (not_after searched from its landing), and no 'not frozen' warning", async () => {
    const w = qslWorld();
    const fx = addAutopilot(w, { lead: 259_200n + 5n, frozen: true });
    const r = await run(w);
    expect([r.level, failing(r)]).toEqual([2, []]);
    expect(part(r, "P.G4").detail).toMatch(
      new RegExp(`frozen by authorization .* \\(kind 2 over the running graph, usable until ${fx.freezeNotAfter}, found after 3541 candidate\\(s\\)\\): it can never change; the running graph took effect 259205 s after its authorization landed \\(at least the 72-hour timelock\\)`),
    );
    expect(part(r, "P.G4").plain).toBe("Its automation is frozen for good, by the creator's quantum-resistant signature.");
    expect([r.programmable.autopilot!.frozen, r.programmable.autopilot!.freezeNotAfter]).toEqual([true, fx.freezeNotAfter]);
    expect(kinds(r)).toEqual([]);
    // With the freeze's not_after given (e.g. from the freeze instruction), one hash.
    const h = await run(w, { freezeNotAfter: fx.freezeNotAfter! });
    expect(part(h, "P.G4").detail).toMatch(/found after 1 candidate\(s\)/);
    // A search cap below the distance fails P.G4 (a component check: the level stays), asking for not_after.
    const c = await run(w, { freezeNotAfterSearchCap: 100 });
    expect([c.level, failing(c), kinds(c)]).toEqual([2, ["P.G4"], ["autopilotUnconfirmed"]]);
    expect(part(c, "P.G4").detail).toMatch(/the search cap of 100 s: pass freezeNotAfter, the freeze instruction's not_after/);
    await expect(checkQsl1(w.conn.asConnection(), w.mint, { freezeNotAfter: 1.5 })).rejects.toThrow(RangeError);
    await expect(checkQsl1(w.conn.asConnection(), w.mint, { freezeNotAfterSearchCap: -1 })).rejects.toThrow(RangeError);
  });

  it("the Rust vector's kind-1 authorization (leaf 46) re-verifies from account state: P.G3 passes; its graph hash names no published graph, so P.G2 fails; the level stays 2", async () => {
    const w = programmableWorld();
    const fx = addVectorActivation(w);
    const r = await run(w);
    expect(statusOf(r, "P.G3")).toBe("pass");
    expect(part(r, "P.G3").detail).toContain(`authorization ${PROG.authorizations.cases[0]!.address} (active_auth; kind 1, leaf 46, landed at ${PROG.launch.landsAt}, slot ${PROG.launch.slot})`);
    expect(part(r, "P.G3").detail).toMatch(new RegExp(`activates the running graph at active_activate_at ${PROG.authorizations.activateAt}$`));
    expect(PROG.authorizations.activeAuth).toBe(PROG.authorizations.cases[0]!.address); // the vectors' active_auth is that authorization
    expect(r.programmable.autopilot!.activateAt).toBe(fx.activateAt);
    // An account that stores no active_auth (written before audit round 4): the activation time is searched (31 candidates).
    const legacy = programmableWorld();
    addVectorActivation(legacy, { legacy: true });
    const l = await run(legacy);
    expect(statusOf(l, "P.G3")).toBe("pass");
    expect(part(l, "P.G3").detail).toMatch(new RegExp(`activates the running graph at ${PROG.authorizations.activateAt} \\(found after 31 candidate\\(s\\)\\)`));
    expect(failing(r)).toEqual(["P.G2"]);
    expect([r.level, r.wouldBe, r.components, r.blocking, r.reasons]).toEqual([2, 2, { rules: true, autopilot: false }, [], []]);
    expect(kinds(r)).toContain("autopilotUnconfirmed");
    // With the vector's kind-2 authorization (freeze payload v2, not_after 1,767,229,200) the graph is frozen by the identity too (P.G4).
    const f = programmableWorld();
    addVectorActivation(f, { frozen: true });
    const s = await run(f);
    expect([statusOf(s, "P.G3"), statusOf(s, "P.G4"), failing(s)]).toEqual(["pass", "pass", ["P.G2"]]);
    expect(part(s, "P.G4").detail).toContain(`frozen by authorization ${PROG.authorizations.cases[1]!.address} (kind 2 over the running graph, usable until ${FREEZE_NOT_AFTER}`);
    expect(s.programmable.autopilot!.freezeNotAfter).toBe(FREEZE_NOT_AFTER);
  });

  it("audit 4, A4-S: with active_auth and active_activate_at the running graph's approval is rebuilt directly, whatever the delay (no 8-day search, no hint needed)", async () => {
    const w = qslWorld();
    const fx = addAutopilot(w, { delay: 10n * 86_400n });
    const r = await run(w, { activateAtSearchCap: 0 });
    expect([statusOf(r, "P.G3"), r.level, r.programmable.autopilot!.activateAt, r.programmable.autopilot!.authorization?.toBase58()]).toEqual(["pass", 2, fx.activateAt, fx.activation.address.toBase58()]);
    // active_auth must be the activation of the running graph at active_activate_at: another time is refused.
    fx.fields.activeActivateAt += 1n;
    const moved = await run(w);
    expect(statusOf(moved, "P.G3")).toBe("fail");
    expect(part(moved, "P.G3").detail).toMatch(/active_auth .* is not PDA\(launchpad; auth, launch, \[1\], SHA256\(PHX-GRAPH-ACT-V1 \|\| autopilot \|\| active_graph \|\| i64le\(active_activate_at/);
  });

  it("the activation time (an account without active_auth): from a caller's hint when activated_at is past the search cap; a wrong hint changes nothing", async () => {
    const w = qslWorld();
    const fx = addAutopilot(w, { delay: 10n * 86_400n, legacy: true });
    let r = await run(w);
    expect([statusOf(r, "P.G3"), r.level]).toEqual(["fail", 2]);
    expect(part(r, "P.G3").detail).toMatch(/not the activation of the running graph at any second from activated_at \d+ down to \d+ \(the search cap of 691200 s: pass the activation time, e\.g\. activate_at of the GraphQueued event\) \(691200 tried\)/);
    expect(r.programmable.autopilot!.activateAt).toBeNull();
    r = await run(w, { activateAt: fx.activateAt });
    expect([statusOf(r, "P.G3"), r.level, r.programmable.autopilot!.activateAt]).toEqual(["pass", 2, fx.activateAt]);
    expect(part(r, "P.G3").detail).toMatch(/\(found after 1 candidate\(s\)\)/);
    r = await run(w, { activateAt: Number(fx.activateAt), activateAtSearchCap: 0 });
    expect(statusOf(r, "P.G3")).toBe("pass");
    const n = qslWorld();
    const nx = addAutopilot(n, { delay: 50n, legacy: true });
    r = await run(n, { activateAt: nx.activateAt + 7n });
    expect(part(r, "P.G3").detail).toMatch(/\(found after 52 candidate\(s\)\)/);
    await expect(checkQsl1(n.conn.asConnection(), n.mint, { activateAt: 1.5 })).rejects.toThrow(RangeError);
    await expect(checkQsl1(n.conn.asConnection(), n.mint, { activateAtSearchCap: -1 })).rejects.toThrow(RangeError);
  });

  it.each<[string, (w: QslWorld, fx: ReturnType<typeof addAutopilot>) => void, string[]]>([
    ["a tampered signature byte of the activation: P.G3 alone", (_w, fx) => void (fx.activation.data![1_000]! ^= 1), ["P.G3"]],
    ["the activation's message_hash tampered", (_w, fx) => void (fx.activation.data![110]! ^= 1), ["P.G3"]],
    ["the activation's leaf bit clear in the identity", (w) => void (w.identity = Uint8Array.from(w.identity, (b, i) => (i === 66 + (100 >> 3) ? b & ~(1 << (100 & 7)) : b))), ["P.G3"]],
    [
      "the activation is a kind-2 authorization over the same payload (wrong kind)",
      (w, fx) => {
        const wrong = signAuthorization(w, 2, fx.activation.fields.payloadHash, 120, fx.activation.fields.unixTime, fx.activation.fields.slot);
        fx.extra.push({ address: wrong.address, owner: PROGRAM_IDS.launchpad, data: wrong.data! });
        fx.fields.authMarks[0] = { slot: wrong.fields.slot, key: wrong.address };
        fx.fields.activeAuth = wrong.address;
      },
      ["P.G3"],
    ],
    [
      "the activation signed by the identity for another graph (payload not the running graph's at any second)",
      (w, fx) => {
        const other = signAuthorization(w, 1, activationPayload(fx.address, sha256(utf8("another graph")), fx.activateAt), 121, fx.activation.fields.unixTime, fx.activation.fields.slot);
        fx.extra.push({ address: other.address, owner: PROGRAM_IDS.launchpad, data: other.data! });
        fx.fields.authMarks[0] = { slot: other.fields.slot, key: other.address };
        fx.fields.activeAuth = other.address;
      },
      ["P.G3"],
    ],
    ["auth_marks[0].slot not the authorization's", (_w, fx) => void (fx.fields.authMarks[0]!.slot += 1n), ["P.G3"]],
    ["auth_marks[0] not active_auth with no update queued", (_w, fx) => void (fx.fields.authMarks[0] = { slot: fx.fields.authMarks[0]!.slot, key: key("qsl/another-activation") }), ["P.G3"]],
    ["active_auth naming an account that is no authorization", (_w, fx) => void (fx.fields.activeAuth = key("qsl/not-an-authorization")), ["P.G3"]],
    ["the activation missing", (_w, fx) => void (fx.activation.data = null), ["P.G3"]],
    ["activated before its authorization landed", (_w, fx) => void (fx.fields.activatedAt = fx.activation.fields.unixTime - 1n), ["P.G3"]],
    ["a pending graph present on an account without active_auth (before audit round 4): the running graph's authorization cannot be read from state (P.G3 alone)", (_w, fx) => void fx, ["P.G3"]],
    ["frozen without a freeze authorization: P.G4 alone", (_w, fx) => void (fx.fields.frozen = 1), ["P.G4"]],
    [
      "frozen with the freeze authorization of another graph",
      (w, fx) => {
        const frz = signAuthorization(w, 2, freezePayload(fx.address, sha256(utf8("another graph")), fx.activateAt + 3_600n), 122, fx.activateAt + 100n, 400_000_200n);
        fx.extra.push({ address: frz.address, owner: PROGRAM_IDS.launchpad, data: frz.data! });
        fx.fields.frozen = 1;
        fx.fields.authMarks[1] = { slot: frz.fields.slot, key: frz.address };
      },
      ["P.G4"],
    ],
    [
      "frozen with a freeze payload v1 (no not_after) over the running graph",
      (w, fx) => {
        const v1 = sha256(new Uint8Array([...utf8("PHX-GRAPH-FRZ-V1"), ...fx.address.toBytes(), ...fx.fields.activeGraph]));
        const frz = signAuthorization(w, 2, v1, 123, fx.activateAt + 100n, 400_000_200n);
        fx.extra.push({ address: frz.address, owner: PROGRAM_IDS.launchpad, data: frz.data! });
        fx.fields.frozen = 1;
        fx.fields.authMarks[1] = { slot: frz.fields.slot, key: frz.address };
      },
      ["P.G4"],
    ],
    ["a frozen byte of 2", (_w, fx) => void (fx.fields.frozen = 2), ["P.G1", "P.G4"]],
    ["the mint not bound", (_w, fx) => void (fx.fields.mint = PublicKey.default), ["P.G1"]],
    ["the autopilot's version 2", (_w, fx) => void (fx.fields.version = 2), ["P.G1"]],
    ["the autopilot's bump", (_w, fx) => void (fx.fields.bump -= 1), ["P.G1"]],
    ["the graph record missing", (_w, fx) => void (fx.graph = null), ["P.G2"]],
    ["a flipped byte of the graph record", (_w, fx) => void (fx.graph!.data[100]! ^= 1), ["P.G2"]],
    ["the graph record owned by the launchpad", (w, fx) => w.patches.push(() => w.conn.set(fx.graph!.address, { owner: PROGRAM_IDS.launchpad, data: fx.graph!.data })), ["P.G2"]],
  ])("%s", async (name, mutate, failed) => {
    const w = qslWorld();
    const fx = addAutopilot(w, name.startsWith("a pending graph") ? { pending: { graphHash: sha256(utf8("queued graph")) }, legacy: true } : {});
    mutate(w, fx);
    const r = await run(w);
    expect(failing(r)).toEqual(failed);
    expect([r.level, r.wouldBe, r.components.autopilot, r.blocking, r.programmable.verified]).toEqual([2, 2, false, [], false]);
    expect(r.programmable.autopilot!.verified).toBe(false);
    expect(kinds(r)).toContain("autopilotUnconfirmed");
  });

  it("a pending update is reported with its time and its own authorization's 72-hour wait (P.G4) and warned about; one that does not wait fails P.G4 too", async () => {
    const w = qslWorld();
    const fx = addAutopilot(w, { pending: { graphHash: sha256(utf8("queued graph")) } });
    const auth = fx.pending!;
    let r = await run(w);
    // Audit 4, A4-S: a queued update no longer hides the running graph's approval (active_auth is stored apart from auth_marks).
    expect(statusOf(r, "P.G3")).toBe("pass");
    expect(part(r, "P.G3").plain).toBe("The creator's quantum-resistant signature switched on this plan (checked just now).");
    expect(part(r, "P.G4").detail).toMatch(/an update to graph [0-9a-f]{64} is queued for \d+, at least 72 hours after its authorization landed/);
    expect(part(r, "P.G1").detail).toMatch(/an update to graph [0-9a-f]{64} is queued for \d+$/);
    expect(r.programmable.autopilot!.pending).toEqual({ graphHash: fx.fields.pendingGraph, activateAt: fx.fields.pendingActivateAt });
    const when = new Date(Number(fx.fields.pendingActivateAt) * 1000).toISOString().slice(0, 16).replace("T", " ");
    expect(r.programmable.warnings.find((x) => x.kind === "updateQueued")!.plain).toBe(`A new automation plan is already queued: it can take over from ${when} UTC.`);
    expect(kinds(r)).toEqual(["updateQueued", "notFrozen"]);
    // Without active_auth (an account written before audit round 4) the running graph's approval cannot be read meanwhile.
    const old = qslWorld();
    addAutopilot(old, { pending: { graphHash: sha256(utf8("queued graph")) }, legacy: true });
    const o = await run(old);
    expect(part(o, "P.G3").plain).toBe("An update to its automation is waiting, so the signature that switched on the current plan can't be checked from the chain right now.");
    expect(kinds(o)).toEqual(["autopilotUnconfirmed", "updateQueued", "notFrozen"]);
    const early = fx.fields.pendingActivateAt - 3_600n;
    const short = signAuthorization(w, 1, activationPayload(fx.address, fx.fields.pendingGraph, early), 103, auth.fields.unixTime, auth.fields.slot);
    fx.extra.push({ address: short.address, owner: PROGRAM_IDS.launchpad, data: short.data! });
    fx.fields.pendingActivateAt = early;
    fx.fields.authMarks[0] = { slot: short.fields.slot, key: short.address };
    r = await run(w);
    expect(failing(r)).toEqual(["P.G4"]);
    expect(part(r, "P.G4").detail).toMatch(/less than 72 hours after its authorization landed/);
  });

  it("P.G5: an autopilot program that can still be changed is a warning, never a level matter (level 2; on devnet a level-2 candidate)", async () => {
    const w = qslWorld();
    addAutopilot(w);
    w.upgradeAuthority.autopilot = key("qsl/upgrader");
    let r = await run(w);
    expect([r.level, r.wouldBe, r.candidate, r.components.autopilot, statusOf(r, "P.G5"), r.blocking]).toEqual([2, 2, false, true, "fail", []]);
    expect(part(r, "P.G5").plain).toBe("The autopilot program can still be changed by its team.");
    expect([r.programmable.verified, r.programmable.autopilot!.verified, r.programmable.autopilot!.programFinal]).toEqual([true, true, false]);
    expect(kinds(r)).toEqual(["notFrozen", "autopilotUpgradeable"]);
    w.genesisHash = GENESIS_HASHES.devnet;
    r = await run(w);
    expect([r.level, r.wouldBe, r.candidate, r.blocking]).toEqual([0, 2, true, ["cluster"]]);
    const b = qslBadge(r);
    expect([b.label, b.name, b.summary, b.programmable?.text]).toEqual(["QSL-1 candidate", "Quantum-attested", "Meets every check for Level 2 (Quantum-attested), but no level is given yet.", "programmable"]);
    // A missing autopilot program: P.G5 fails, the automation's checks still pass; the level stays 2.
    const m = qslWorld();
    addAutopilot(m);
    del(m, programDataAddress(PROGRAM_IDS.autopilot));
    r = await run(m);
    expect([r.level, r.wouldBe, r.components.autopilot, failing(r)]).toEqual([2, 2, true, ["P.G5"]]);
    expect(part(r, "P.G5").plain).toBe("The autopilot program could not be read, so its automation can't be confirmed.");
  });

  it("operator-controlled steps: the operator and how many steps it runs are a warning; a revoked operator is not", async () => {
    const graph = decompileGraph(AI_GRAPH);
    const steps = graph.nodes.filter((n) => n.operatorGated).length;
    expect([graph.operator === null, steps > 0]).toEqual([false, true]);
    const w = qslWorld();
    const fx = addAutopilot(w, { graph: AI_GRAPH });
    fx.fields.operator = new PublicKey(graph.operator!);
    let r = await run(w);
    expect(failing(r)).toEqual([]);
    expect(r.programmable.autopilot!.operatorSteps).toBe(steps);
    const op = r.programmable.warnings.find((x) => x.kind === "operator")!;
    expect(op.plain).toBe(`${steps === 1 ? "One automation step is" : `${steps} automation steps are`} run by a wallet the creator chose (${graph.operator}), which decides when and how much, within fixed limits.`);
    expect(op.wallets).toEqual([graph.operator]);
    expect(kinds(r)).toEqual(["operator", "notFrozen"]);
    fx.fields.operator = PublicKey.default;
    r = await run(w);
    expect([r.programmable.autopilot!.operatorSteps, kinds(r)]).toEqual([0, ["notFrozen"]]);
  });

  it("an autopilot that runs no graph, or a foreign account at its address, is not present: P.G* not used", async () => {
    const cases: ((w: QslWorld) => void)[] = [
      (w) => {
        const fx = addAutopilot(w);
        fx.fields.activeGraph = new Uint8Array(32);
      },
      (w) => w.patches.push(() => w.conn.set(autopilotAddress(w.launch), { owner: new PublicKey("11111111111111111111111111111111"), data: new Uint8Array(0) })),
    ];
    for (const mutate of cases) {
      const w = qslWorld();
      mutate(w);
      const r = await run(w);
      expect([r.level, r.wouldBe, partsNotPassing(r).filter((x) => x.startsWith("P.G")), r.programmable.present, r.programmable.autopilot]).toEqual([2, 2, notUsed(G_IDS), false, undefined]);
    }
    const w = qslWorld();
    w.patches.push(() => w.conn.set(autopilotAddress(w.launch), { owner: PROGRAM_IDS.autopilot, data: new Uint8Array(100) }));
    const r = await run(w);
    expect([r.level, statusOf(r, "P.G1"), r.programmable.present, r.programmable.verified, r.autopilot]).toEqual([2, "fail", true, false, null]);
  });

  it("evaluateQsl1 on the same accounts gives the same result (pure), with the same options", async () => {
    const w = programmableWorld();
    const fx = addAutopilot(w, { delay: 10n * 86_400n, frozen: true });
    const live = await run(w, { activateAt: fx.activateAt, freezeNotAfter: fx.freezeNotAfter! });
    const accounts = new Map<string, QslAccount | null>();
    for (const [k, a] of w.conn.accounts) accounts.set(k, { owner: a.owner, data: a.data, executable: a.executable ?? false });
    const offline = evaluateQsl1({ mint: w.mint, genesisHash: GENESIS_HASHES.mainnet, slot: 400_000_000, accounts, launchAuthorityTokenAccounts: null }, { activateAt: fx.activateAt, freezeNotAfter: fx.freezeNotAfter! });
    const json = (x: unknown): string => JSON.stringify(x, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v instanceof Uint8Array ? toHex(v) : v));
    expect(json(offline)).toBe(json(live));
    expect([live.level, live.programmable.present]).toEqual([2, true]);
  });
});

// --------------------------------------------------------- the searches ---

describe("findActivateAt (P.G3) and findFreezeNotAfter (P.G4)", () => {
  const autopilot = key("qsl/autopilot");
  const graph = sha256(utf8("graph"));
  it("findActivateAt: the second a payload commits to, from activated_at down to the authorization, the hint first", () => {
    const payload = activationPayload(autopilot, graph, 1_000_500n);
    expect(findActivateAt(autopilot, graph, payload, { activatedAt: 1_000_600n, authorizedAt: 1_000_000n })).toEqual({ activateAt: 1_000_500n, tried: 101, truncated: false });
    expect(findActivateAt(autopilot, graph, payload, { activatedAt: 1_000_600n, authorizedAt: 1_000_000n }, { hint: 1_000_500 })).toEqual({ activateAt: 1_000_500n, tried: 1, truncated: false });
    expect(findActivateAt(autopilot, graph, payload, { activatedAt: 1_000_499n, authorizedAt: 1_000_000n }, { hint: 1_000_500n })).toEqual({ activateAt: null, tried: 500, truncated: false });
    expect(findActivateAt(autopilot, graph, payload, { activatedAt: 1_000_600n, authorizedAt: 1_000_501n })).toEqual({ activateAt: null, tried: 100, truncated: false });
    expect(findActivateAt(autopilot, graph, payload, { activatedAt: 1_000_600n, authorizedAt: 1_000_000n }, { cap: 50 })).toEqual({ activateAt: null, tried: 50, truncated: true });
    expect(findActivateAt(autopilot, graph, payload, { activatedAt: 5n, authorizedAt: 10n })).toEqual({ activateAt: null, tried: 0, truncated: false });
    expect(() => findActivateAt(autopilot, graph, payload, { activatedAt: 1n, authorizedAt: 0n }, { cap: 0.5 })).toThrow(RangeError);
  });

  it("findFreezeNotAfter: the not_after a freeze payload v2 commits to, from the authorization's landing up, the hint first", () => {
    const payload = freezePayload(autopilot, graph, 1_003_600n);
    expect(findFreezeNotAfter(autopilot, graph, payload, 1_000_000n)).toEqual({ notAfter: 1_003_600n, tried: 3_601, truncated: false });
    expect(findFreezeNotAfter(autopilot, graph, payload, 1_000_000n, { hint: 1_003_600 })).toEqual({ notAfter: 1_003_600n, tried: 1, truncated: false });
    // Below the landing it is never found (the program would have refused it: FreezeExpired), a hint there is not tried.
    expect(findFreezeNotAfter(autopilot, graph, payload, 1_003_601n, { hint: 1_003_600n, cap: 10 })).toEqual({ notAfter: null, tried: 10, truncated: true });
    expect(findFreezeNotAfter(autopilot, graph, payload, 1_000_000n, { cap: 50 })).toEqual({ notAfter: null, tried: 50, truncated: true });
    expect(() => findFreezeNotAfter(autopilot, graph, payload, 0n, { cap: -1 })).toThrow(RangeError);
  });

  it("the full default ranges (691,200 candidates each, 8 days) are bounded: measured here", () => {
    let t = performance.now();
    const r = findActivateAt(autopilot, graph, new Uint8Array(32), { activatedAt: 1_800_000_000n, authorizedAt: 0n });
    expect([r.activateAt, r.tried, r.truncated]).toEqual([null, QSL1.ACTIVATE_AT_SEARCH_CAP, true]);
    console.log(`findActivateAt: ${QSL1.ACTIVATE_AT_SEARCH_CAP} candidates in ${Math.round(performance.now() - t)} ms`);
    t = performance.now();
    const f = findFreezeNotAfter(autopilot, graph, new Uint8Array(32), 1_800_000_000n);
    expect([f.notAfter, f.tried, f.truncated]).toEqual([null, QSL1.FREEZE_NOT_AFTER_SEARCH_CAP, true]);
    const ms = performance.now() - t;
    console.log(`findFreezeNotAfter: ${QSL1.FREEZE_NOT_AFTER_SEARCH_CAP} candidates in ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(20_000);
  });
});

// ---------------------------------------------------------- the badge ---

/** Appendix A.3: what no app may say. */
const FORBIDDEN = [/quantum-proof/i, /quantum-safe/i, /unhackable/i, /can'?t lose value/i, /safe investment/i, /risk-free/i, /verified (project|team)/i, /\bofficial\b/i, /trusted creator/i, /\baudited\b/i, /\bprivate\b/i, /\banonymous\b/i];
/** Revision 0.4 Appendix A.2: the programmable tag never claims more safety. */
const NOT_SAFER = [/\bsafer\b/i, /level 3/i, /\bL3\b/, /more secure/i, /extra protection/i, /protected by/i];
const L1_REQUIRED = "This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams.";
const L2_REQUIRED = "The token itself sits in normal wallets, which are not quantum-resistant.";

describe("qslBadge: the 'programmable' tag next to the level (Appendix A.2)", () => {
  it("rules: 'QSL-1 L2 · programmable', 'read its rules', the tag's sentence and warnings right after the summary; the badge itself is L2's", async () => {
    const r = await run(programmableWorld());
    const b = qslBadge(r);
    expect([b.label, b.name, b.title, b.tone, b.showOnTradeScreen, b.mint]).toEqual(["QSL-1 L2", "Quantum-attested", "QSL-1 · Quantum-attested", "positive", true, r.mint.toBase58()]);
    expect(b.summary).toBe("Launched with its creator's quantum-resistant signature, checked just now.");
    const p = b.programmable!;
    expect([p.tag, p.text, p.link, p.tone]).toEqual(["programmable", "QSL-1 L2 · programmable", "read its rules", "caution"]);
    expect(p.summary).toBe("Its creator added launch rules that limit some transfers for a while. They are not a safety feature: read its rules.");
    expect(p.explain).toEqual(r.programmable.rules!.explain);
    expect(p.warnings).toEqual(r.programmable.warnings.map((x) => x.plain));
    expect(b.lines.slice(0, 2 + p.warnings.length)).toEqual([b.summary, p.summary, ...p.warnings]);
    expect(b.required).toEqual([L1_REQUIRED, L2_REQUIRED]);
    expect(b.lines.slice(-2)).toEqual(b.required);
  });

  it("rules and automation; automation alone; level 1: the tag follows the level's label", async () => {
    const w = programmableWorld();
    addAutopilot(w, { frozen: true });
    let b = qslBadge(await run(w));
    expect([b.label, b.programmable!.summary]).toEqual(["QSL-1 L2", "Its creator added launch rules and automation. They are not a safety feature: read its rules."]);
    expect(b.programmable!.explain.length).toBeGreaterThan(r0(w));
    const a = qslWorld();
    addAutopilot(a, { frozen: true });
    b = qslBadge(await run(a));
    expect([b.programmable!.summary, b.programmable!.tone, b.programmable!.warnings]).toEqual(["Its creator set up automation that runs on its treasury. It is not a safety feature: read its rules.", "neutral", []]);
    const one = programmableWorld();
    patch(one, new PublicKey(PROG.attestation.address), (d) => void (d[108]! ^= 1));
    b = qslBadge(await run(one));
    expect([b.label, b.programmable!.text]).toEqual(["QSL-1 L1", "QSL-1 L1 · programmable"]);
  });

  it("no sentence says anything A.3 forbids or that programmable is safer; every sentence ends with a full stop", async () => {
    const worlds: QslWorld[] = [];
    const a = programmableWorld();
    addAutopilot(a, { frozen: true });
    worlds.push(a);
    const v = programmableWorld();
    addVectorActivation(v);
    worlds.push(v);
    const p = qslWorld();
    const fx = addAutopilot(p, { graph: AI_GRAPH, pending: { graphHash: sha256(utf8("queued graph")) } });
    fx.fields.operator = new PublicKey(decompileGraph(AI_GRAPH).operator!);
    worlds.push(p);
    const u = qslWorld();
    addAutopilot(u);
    u.upgradeAuthority.autopilot = key("qsl/upgrader");
    u.genesisHash = GENESIS_HASHES.devnet;
    worlds.push(u);
    const labels: string[] = [];
    for (const w of worlds) {
      const r = await run(w);
      const b = qslBadge(r);
      labels.push(`${b.label}${b.programmable === null ? "" : ` / ${b.programmable.text}`}`);
      const titles = [b.title, ...r.checks.map((c) => c.title), ...r.programmable.checks.map((c) => c.title)];
      const sentences = [b.summary, ...b.lines, ...r.reasons, ...r.checks.map((c) => c.plain), ...r.programmable.checks.map((c) => c.plain), ...r.programmable.warnings.map((x) => x.plain), ...(b.programmable?.explain ?? [])];
      for (const t of [...titles, ...sentences]) for (const f of [...FORBIDDEN, ...NOT_SAFER]) expect(f.test(t), `${t} (${f})`).toBe(false);
      for (const s of [b.summary, ...b.lines, ...r.reasons, ...r.checks.map((c) => c.plain), ...r.programmable.checks.map((c) => c.plain)]) expect(s, s).toMatch(/^[A-Z].*[.)]$/);
    }
    expect(labels).toEqual(["QSL-1 L2 / QSL-1 L2 · programmable", "QSL-1 L2 / QSL-1 L2 · programmable", "QSL-1 L2 / QSL-1 L2 · programmable", "QSL-1 candidate / programmable"]);
  });
});

/** The number of plain-English lines of the typical rules alone. */
function r0(_w: QslWorld): number {
  return explainRules(fromHex(TYPICAL_RULES.bytes), { guardSecs: 3_600, tokenDecimals: 6 }).length;
}

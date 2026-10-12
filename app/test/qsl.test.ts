/**
 * QSL-1 in the app (docs/standard/QSL-1.md revision 0.4, §7.9 and Appendix A; LAYER_V1 §B.3): the verdict from a
 * verification report, the badge's words, and the rules that keep a badge honest (no level off mainnet or before
 * finality, nothing on mainnet cards for a candidate, none of Appendix A.3's forbidden claims). Two levels only:
 * "programmable" is a tag next to the level ("QSL-1 L2 · programmable — read its rules") with the SDK's warnings,
 * never a level, never a better-looking badge.
 */
import { qslBadge, QSL1_CONDITION_IDS, type QslProgrammable, type QslResult } from "@noisedlabs/sdk";
import { Connection as Web3Connection, Keypair, type Connection } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";

import { backend as live } from "../src/lib/backend/live";
import { backend as mock } from "../src/lib/backend/mock";
import { seedState } from "../src/lib/mock/fixtures";
import { resetProgrammableForTests } from "../src/lib/mock/programmable";
import { replaceStateForTests } from "../src/lib/mock/store";
import { FORBIDDEN_CLAIMS, LEVELS, PROGRAMMABLE_MEANS, PROGRAMMABLE_SUMMARY, programmableView, qslBadgeView, qslFromReport, qslFromSdk, type QslVerdict } from "../src/lib/qsl";
import type { CheckStatus, VerificationCheck, VerificationReport } from "../src/lib/noised";

const mint = Keypair.generate().publicKey;

/** The SDK's report ids for every L1 and L2 condition group, all passing. */
const SDK_IDS = [
  "certificate.exists",
  "certificate.account",
  "certificate.checks",
  "launch.account",
  "mint.mintAuthority",
  "mint.freezeAuthority",
  "mint.metadata",
  "mint.metadataPointer",
  "mint.extensions",
  "mint.transferHook",
  "mint.supply",
  "dbc.config",
  "dbc.lpLocked",
  "dbc.noMigrationFee",
  "dbc.noCreatorAllocation",
  "dbc.quoteWsol",
  "dbc.fees",
  "dbc.pool",
  "hook.policy",
  "hook.metaList",
  "pq.origin",
  "metadata.onchain",
  "metadata.match",
  "metadata.icon",
  "batch.cap",
  "damm.status",
];

function report(over: Record<string, CheckStatus> = {}, programs: CheckStatus | null = "pass", drop: readonly string[] = []): VerificationReport {
  const ids = [...SDK_IDS, ...(programs === null ? [] : ["program.launchpad", "program.hook"])].filter((id) => !drop.includes(id));
  const checks: VerificationCheck[] = ids.map((id) => ({
    id,
    label: id,
    status: over[id] ?? (id.startsWith("program.") && programs !== null ? programs : "pass"),
    detail: `${id} detail`,
  }));
  return {
    mint,
    overall: checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass",
    phase: "guarded",
    checks,
    trustedParties: [{ name: "Meteora upgrade multisig", address: null, kind: "upgrade-multisig", note: "can upgrade DBC" }],
    certificate: null,
    pqOrigin: null,
    metadata: null,
    rules: null,
  };
}

/** Every text a badge can show (the programmable tag's too). */
const badgeText = (v: QslVerdict): string => {
  const b = qslBadgeView(v, "page");
  const p = b?.programmable ?? null;
  return b === null ? "" : [b.label, b.short, b.line, ...b.lines, ...b.required, ...(p === null ? [] : [p.text, p.link, p.summary, ...p.warnings.map((w) => w.plain)])].join(" ");
};

/** The creator's rules and automation in the SDK's shape (QSL-1 revision 0.4): rules with two warnings by default. */
function programmable(over: Partial<QslProgrammable> = {}): QslProgrammable {
  return {
    present: true,
    verified: true,
    rules: { hash: new Uint8Array(32).fill(1), hashHex: "01".repeat(32), address: mint, bytes: null, explain: ["For the first 2 hours, only listed wallets can buy.", "Selling is always allowed: no rule can block a sell."], verified: true },
    checks: [{ id: "P.R1", component: "rules", title: "Launch rules recorded", status: "pass", ok: true, plain: "Its launch certificate records the launch rules its creator signed.", detail: "" }],
    warnings: [
      { kind: "insiderBuying", component: "rules", plain: "For the first 2 hours, only 2 wallets chosen by the creator can buy; everyone else's buys are refused (rule 1).", rule: 0 },
      { kind: "longRule", component: "rules", plain: "Rule 1 stays on for 2 hours, more than an hour.", rule: 0 },
    ],
    ...over,
  };
}

describe("QSL-1 verdict from a verification report", () => {
  it("awards Quantum-attested on mainnet with finalized programs and every check passing", () => {
    const v = qslFromReport(report(), "mainnet");
    expect(v).toMatchObject({ standard: "QSL-1", level: 2, wouldBe: 2, candidate: false, certified: true });
    expect(v.checks.every((c) => c.ok)).toBe(true);
    // Level 2 is the top: nothing more to reach (there is no level 3).
    expect(v.reasons).toEqual([]);
    expect(v.programmable).toBeNull();
    expect(v.trusted.length).toBe(1);
    const b = qslBadgeView(v, "card");
    expect(b?.label).toBe("QSL-1 · Quantum-attested");
    expect(b?.line).toBe("Launched with its creator's quantum-resistant signature, checked just now.");
    expect(b?.required).toEqual([
      "This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams.",
      "The token itself sits in normal wallets, which are not quantum-resistant.",
    ]);
  });

  it("is only a candidate while Noised's programs can be upgraded (a warning in the report), even on mainnet", () => {
    const v = qslFromReport(report({}, "warn"), "mainnet");
    expect(v).toMatchObject({ level: 0, candidate: true, wouldBe: 2 });
    expect(v.reasons[0]).toMatch(/can still be upgraded/);
    // Appendix A.1: on mainnet a candidate shows nothing on cards and trade screens, but the token page may explain it.
    expect(qslBadgeView(v, "card")).toBeNull();
    expect(qslBadgeView(v, "page")?.label).toBe("QSL-1 candidate");
  });

  it("never awards a level off mainnet: devnet with final programs is a candidate, shown as one on cards", () => {
    const v = qslFromReport(report(), "devnet");
    expect(v).toMatchObject({ level: 0, candidate: true, wouldBe: 2 });
    expect(v.reasons).toContain("Levels are given only on Solana mainnet; this is a test network.");
    const b = qslBadgeView(v, "card");
    expect(b).toMatchObject({ label: "QSL-1 candidate", tone: "candidate", pips: 2 });
    expect(b?.line).toMatch(/^Passes every check for Quantum-attested\. Not final yet/);
  });

  it("fails closed when the report does not say whether the programs are final (the simulated chain)", () => {
    const v = qslFromReport(report({}, null), "mainnet");
    expect(v).toMatchObject({ level: 0, candidate: true });
    expect(v.checks.find((c) => c.id === "final")).toMatchObject({ ok: false, plain: "Noised's programs can still be upgraded" });
  });

  it("is No-rug when the post-quantum signature does not verify", () => {
    const v = qslFromReport(report({ "pq.origin": "fail" }), "mainnet");
    expect(v).toMatchObject({ level: 1, wouldBe: 1, candidate: false });
    expect(v.reasons).toEqual(["No valid quantum-resistant signature from its creator."]);
    const b = qslBadgeView(v, "card");
    expect(b).toMatchObject({ label: "QSL-1 · No-rug", pips: 1 });
    expect(b?.line).toBe("Nobody can mint more, freeze your tokens, change its name or pull its liquidity.");
    expect(b?.required).toEqual(["This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams."]);
  });

  it("is not QSL-1 when a level-1 guarantee fails, and says which one; cards show nothing", () => {
    const v = qslFromReport(report({ "mint.mintAuthority": "fail" }), "mainnet");
    expect(v).toMatchObject({ level: 0, wouldBe: 0, candidate: false, certified: true });
    expect(v.reasons).toEqual(["More tokens could be minted."]);
    expect(qslBadgeView(v, "card")).toBeNull();
    expect(qslBadgeView(v, "page")).toMatchObject({ label: "Not QSL-1", pips: 0, line: "More tokens could be minted." });
  });

  it("fails closed when a condition is missing from the report", () => {
    expect(qslFromReport(report({}, "pass", ["hook.policy", "hook.metaList", "mint.transferHook"]), "mainnet")).toMatchObject({ level: 0, candidate: false });
  });

  it("does not apply to a mint without a certificate", () => {
    const v = qslFromReport(report({ "certificate.exists": "fail" }), "mainnet");
    expect(v).toMatchObject({ level: 0, candidate: false, certified: false });
    expect(v.reasons).toEqual(["Noised did not launch this token, so QSL-1 does not apply to it."]);
    expect(qslBadgeView(v, "page")?.label).toBe("Not QSL-1");
  });

  it("maps the simulated chain's certificate-bit ids too", () => {
    const ids = ["certificate.exists", "certificate.launch", "certificate.params", "certificate.checks", "fees.routing", "hook.policy", "hook.metaList", "pq.origin", "metadata.onchain", "metadata.match"];
    const bits = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048].map((b) => `certificate.bit${b}`);
    const r: VerificationReport = { ...report(), checks: [...ids, ...bits].map((id) => ({ id, label: id, status: "pass", detail: "" })) };
    expect(qslFromReport(r, "devnet")).toMatchObject({ level: 0, candidate: true, wouldBe: 2 });
  });

  it("adds the external-link line when the record points to a link its creator chose", () => {
    const v = qslFromReport(report({ "metadata.onchain": "warn" }), "mainnet");
    expect(v.level).toBe(2);
    expect(qslBadgeView(v, "page")?.required).toContain("Its icon link was chosen by the creator; what it shows can change.");
  });

  it("has two levels only: No-rug and Quantum-attested", () => {
    expect(LEVELS.map((l) => [l.level, l.name])).toEqual([
      [1, "No-rug"],
      [2, "Quantum-attested"],
    ]);
  });
});

describe("programmable is a tag next to the level, never a level (QSL-1 revision 0.4, review 4 R2)", () => {
  it("a level-2 token with rules shows 'QSL-1 L2 · programmable — read its rules' and its warnings; the level and badge do not change", () => {
    const plain = qslFromReport(report(), "mainnet");
    const v = qslFromReport(report(), "mainnet", programmable());
    expect(v.level).toBe(2);
    expect(v.programmable).toMatchObject({ text: "QSL-1 L2 · programmable", link: "read its rules", tone: "caution", hasRules: true, hasAutomation: false, summary: PROGRAMMABLE_SUMMARY.rules });
    expect(v.programmable?.warnings.map((w) => w.kind)).toEqual(["insiderBuying", "longRule"]);
    expect(v.programmable?.rules[0]).toBe("For the first 2 hours, only listed wallets can buy.");
    const with_ = qslBadgeView(v, "page");
    const without = qslBadgeView(plain, "page");
    // The badge itself is the same: same label, words, tone and bars.
    expect({ ...with_, programmable: null }).toEqual({ ...without, programmable: null });
    expect(with_?.programmable?.text).toBe("QSL-1 L2 · programmable");
  });

  it("next to No-rug it is 'QSL-1 L1 · programmable'; next to a candidate or Not QSL-1 just 'programmable'", () => {
    expect(qslFromReport(report({ "pq.origin": "fail" }), "mainnet", programmable()).programmable?.text).toBe("QSL-1 L1 · programmable");
    expect(qslFromReport(report(), "devnet", programmable()).programmable?.text).toBe("programmable");
    expect(qslFromReport(report({ "mint.mintAuthority": "fail" }), "mainnet", programmable()).programmable?.text).toBe("programmable");
  });

  it("is neutral without warnings, never positive; automation alone and both have their own sentence", () => {
    expect(programmableView(programmable({ warnings: [] }), 2)?.tone).toBe("neutral");
    const auto = programmableView(programmable({ rules: undefined, autopilot: { explain: ["Every day, buy back and burn."] } as unknown as QslProgrammable["autopilot"] }), 2);
    expect(auto).toMatchObject({ summary: PROGRAMMABLE_SUMMARY.autopilot, hasRules: false, hasAutomation: true, automation: ["Every day, buy back and burn."] });
    const both = programmableView(programmable({ autopilot: { explain: ["x"] } as unknown as QslProgrammable["autopilot"] }), 2);
    expect(both?.summary).toBe(PROGRAMMABLE_SUMMARY.both);
    expect(programmableView(programmable({ present: false }), 2)).toBeNull();
    expect(programmableView(null, 2)).toBeNull();
  });

  it("uses the same words as the SDK's qslBadge for the same rules (L2, candidate, automation)", () => {
    for (const [over, p] of [
      [{}, programmable()],
      [{ cluster: "devnet" as const, level: 0 as const, candidate: true, blocking: ["cluster"] as string[] }, programmable()],
      [{}, programmable({ warnings: [], rules: undefined, autopilot: { explain: ["y"] } as unknown as QslProgrammable["autopilot"] })],
    ] as const) {
      const r = sdkResult({ ...over, programmable: p });
      const tag = qslBadge(r).programmable;
      const mine = programmableView(p, r.level);
      expect(mine).toMatchObject({ text: tag?.text, summary: tag?.summary, tone: tag?.tone, link: tag?.link });
      expect(mine?.warnings.map((w) => w.plain)).toEqual(tag?.warnings);
      // And the live path keeps exactly the SDK's tag.
      expect(qslFromSdk(r, qslBadge(r)).programmable).toMatchObject({ text: tag?.text, summary: tag?.summary, tone: tag?.tone });
    }
  });

  it("the SDK's lines keep the tag's sentence and warnings out of 'what this means for you'", () => {
    const r = sdkResult({ programmable: programmable() });
    const b = qslBadgeView(qslFromSdk(r, qslBadge(r)), "page");
    expect(b?.lines.some((l) => l.includes("not a safety feature"))).toBe(false);
    expect(b?.lines.some((l) => l.includes("only 2 wallets"))).toBe(false);
  });

  it("never says safer, never calls it a level", () => {
    const v = qslFromReport(report(), "mainnet", programmable());
    const text = badgeText(v);
    expect(text).not.toMatch(/\bsafer\b|level 3|L3\b/i);
    expect(PROGRAMMABLE_MEANS).toMatch(/^Programmable is not a level and not a safety feature/);
  });
});

describe("the simulated chain's verdicts carry the SDK's programmable warnings", () => {
  const conn = new Web3Connection("http://127.0.0.1:8899");
  beforeEach(() => {
    replaceStateForTests(seedState());
    resetProgrammableForTests();
  });
  const mintOf = async (symbol: string) => {
    const l = (await mock.listLaunches(conn)).find((x) => x.market?.symbol === symbol);
    if (!l) throw new Error(`no ${symbol}`);
    return l.baseMint;
  };

  it("AEGS (rules bound by its certificate): a candidate with the 'programmable' tag, its rules and the SDK's rule warnings", async () => {
    const v = await mock.checkQsl1(conn, await mintOf("AEGS"));
    expect(v).toMatchObject({ level: 0, candidate: true, wouldBe: 2 });
    expect(v.programmable).toMatchObject({ text: "programmable", link: "read its rules", hasRules: true, verified: true });
    expect(v.programmable?.rules.length).toBeGreaterThan(3);
    expect(v.programmable?.rules).toContain("Rules never apply to holders using the Noised vault or shield directly (the built-in launch guard still does).");
    expect(v.programmable?.warnings.length).toBeGreaterThan(0);
    expect(v.programmable?.warnings.every((w) => w.component === "rules")).toBe(true);
    expect(v.programmable?.tone).toBe("caution");
  });

  it("MRDN (a running autopilot, not frozen): automation warnings; CNDR (frozen) has no 'not frozen' warning", async () => {
    const m = await mock.checkQsl1(conn, await mintOf("MRDN"));
    expect(m.programmable?.hasAutomation).toBe(true);
    expect(m.programmable?.warnings.map((w) => w.kind)).toContain("notFrozen");
    expect(m.programmable?.automation.length).toBeGreaterThan(0);
    const c = await mock.checkQsl1(conn, await mintOf("CNDR"));
    expect(c.programmable?.hasAutomation).toBe(true);
    expect(c.programmable?.warnings.map((w) => w.kind)).not.toContain("notFrozen");
  });

  it("LNTN (an early allowlist and a whale cap): insider-only buying first, then transfer limits and a long rule", async () => {
    const v = await mock.checkQsl1(conn, await mintOf("LNTN"));
    const kinds = v.programmable?.warnings.map((w) => w.kind) ?? [];
    expect(kinds[0]).toBe("insiderBuying");
    expect(kinds).toEqual(expect.arrayContaining(["transferLimits", "longRule"]));
    expect(v.programmable?.warnings[0]?.plain).toMatch(/only 2 wallets chosen by the creator can buy/);
  });

  it("a token with neither has no tag", async () => {
    const launches = await mock.listLaunches(conn);
    const plainOne = launches.find((l) => l.status === "live" && !["AEGS", "LNTN", "MRDN", "CNDR", "BSTN"].includes(l.market?.symbol ?? ""));
    if (!plainOne) return;
    expect((await mock.checkQsl1(conn, plainOne.baseMint)).programmable).toBeNull();
  });
});

describe("QSL-1 badge wording (Appendix A.3)", () => {
  it("never makes a forbidden claim in any badge", () => {
    const verdicts = [
      qslFromReport(report(), "mainnet"),
      qslFromReport(report({ "pq.origin": "fail" }), "mainnet"),
      qslFromReport(report({}, "warn"), "devnet"),
      qslFromReport(report({ "mint.freezeAuthority": "fail" }), "mainnet"),
      qslFromReport(report({ "certificate.exists": "fail" }), "mainnet"),
      qslFromReport(report({ "metadata.onchain": "warn" }), "mainnet"),
    ];
    for (const v of verdicts) {
      const text = badgeText(v);
      expect(text.length).toBeGreaterThan(0);
      for (const re of FORBIDDEN_CLAIMS) expect(text, `${re}`).not.toMatch(re);
    }
    for (const l of LEVELS) for (const re of FORBIDDEN_CLAIMS) expect(l.line).not.toMatch(re);
  });
});

/** A `checkQsl1` result as SDK 0.5.0 returns it, every condition passing unless told otherwise. */
function sdkResult(over: Partial<QslResult> = {}, failing: readonly string[] = []): QslResult {
  return {
    standard: "QSL-1",
    mint,
    slot: 1,
    cluster: "mainnet",
    level: 2,
    candidate: false,
    wouldBe: 2,
    programmable: { present: false, verified: true, checks: [], warnings: [] },
    components: { rules: false, autopilot: false },
    graduated: false,
    migrated: false,
    checks: QSL1_CONDITION_IDS.map((id) => {
      const fail = failing.includes(id);
      return { id, level: id.startsWith("C2") ? 2 : 1, title: id, status: fail ? "fail" : "pass", ok: !fail, plain: `${id} plain.`, detail: `${id} detail` } as const;
    }),
    reasons: [],
    blocking: [],
    info: [],
    trusted: [],
    uriMode: 0,
    ...over,
  };
}

describe("QSL-1 from the SDK (checkQsl1 and qslBadge, SDK 0.5.0)", () => {
  it("keeps the SDK's level, candidate state, reasons and checks, and shows the SDK's own badge words", () => {
    const r = sdkResult();
    const v = qslFromSdk(r, qslBadge(r));
    expect(v).toMatchObject({ source: "sdk", level: 2, candidate: false, wouldBe: 2, certified: true, cluster: "mainnet" });
    expect(v.checks.map((c) => c.id)).toEqual([...QSL1_CONDITION_IDS]);
    const b = qslBadgeView(v, "card");
    expect(b?.label).toBe("QSL-1 · Quantum-attested");
    expect(b?.line).toBe(qslBadge(r).summary);
    expect(b?.required).toEqual(qslBadge(r).required);
    expect(b?.lines).not.toContain(b?.line);
  });

  it("shows a devnet candidate on cards, and hides a mainnet candidate there (the SDK's showOnTradeScreen)", () => {
    const dev = sdkResult({ cluster: "devnet", level: 0, candidate: true, reasons: ["This is Solana devnet, a test network; levels are given only on mainnet."] }, ["cluster", "C1.24"]);
    const v = qslFromSdk(dev, qslBadge(dev));
    expect(qslBadgeView(v, "card")).toMatchObject({ label: "QSL-1 candidate: not final yet", tone: "candidate", pips: 2 });
    const main = sdkResult({ level: 0, candidate: true }, ["C1.24"]);
    expect(qslBadgeView(qslFromSdk(main, qslBadge(main)), "card")).toBeNull();
    expect(qslBadgeView(qslFromSdk(main, qslBadge(main)), "page")?.label).toBe("QSL-1 candidate: not final yet");
  });

  it("is not certified when C1.1 fails, and the external-link line follows uriMode 2", () => {
    const none = sdkResult({ level: 0, wouldBe: 0, candidate: false }, ["C1.1"]);
    expect(qslFromSdk(none, qslBadge(none))).toMatchObject({ certified: false, level: 0 });
    const ext = sdkResult({ uriMode: 2 });
    expect(qslFromSdk(ext, qslBadge(ext)).externalLink).toBe(true);
  });

  it("the live backend runs the SDK's checkQsl1: a devnet endpoint and no certificate is not QSL-1", async () => {
    const conn = {
      getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      getMultipleAccountsInfoAndContext: async (keys: unknown[]) => ({ context: { slot: 7 }, value: keys.map(() => null) }),
      getTokenAccountsByOwner: async () => ({ context: { slot: 7 }, value: [] }),
    } as unknown as Connection;
    const v = await live.checkQsl1(conn, mint);
    expect(v).toMatchObject({ source: "sdk", level: 0, candidate: false, certified: false });
    // The hash devnet serves reads as devnet (SDK 0.5.1; 0.5.0's wrong devnet hash read it as "other"): no level either way.
    expect(v.cluster).toBe("devnet");
    expect(v.words?.title).toBe("Not QSL-1");
    expect(qslBadgeView(v, "page")?.label).toBe("Not QSL-1");
  });
});

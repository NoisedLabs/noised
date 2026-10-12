/**
 * Quick launch (`src/launch/quick.ts`): the plan from the short form for
 * each fee destination (recipients, the autopilot treasury, the daily
 * buyback-and-burn graph), the fee and form validation (every problem in
 * one error), the parameters against the Fair preset and the program's
 * policy, determinism, the full launch plan with `opensAt`, plain English
 * for the creator, and the buyback settings' ranges.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { PUBLISH_GRAPH_LEGACY_MAX_BYTES } from "../src/autopilot/builders.js";
import { utf8 } from "../src/codec/bytes.js";
import { DBC } from "../src/constants.js";
import { planLaunch } from "../src/launch/flow.js";
import { launchParamsHash } from "../src/launch/hash.js";
import { validateLaunchParams } from "../src/launch/policy.js";
import { dynamicFeeFor, PRESETS } from "../src/launch/presets.js";
import {
  planQuickLaunch,
  QUICK_LAUNCH_BUYBACK_DEFAULTS,
  QUICK_LAUNCH_BUYBACK_RANGES,
  QUICK_LAUNCH_FEE_BPS_RANGE,
  type QuickLaunchInput,
  type QuickLaunchPlan,
} from "../src/launch/quick.js";
import { buildMetadataDoc } from "../src/metadata/doc.js";
import { encodeIndexedPng } from "../src/metadata/png.js";
import { metadataHashV2, validateTokenMeta } from "../src/metadata/record.js";
import { autopilotTreasuryAddress, launchPdas } from "../src/pda.js";
import { verifyGraph } from "../src/programmable/graph/codec.js";
import { compileGraph } from "../src/programmable/graph/model.js";
import { graphHash } from "../src/programmable/hash.js";
import { GRAPH_TEMPLATES, graphTemplate } from "../src/programmable/templates.js";
import { key } from "./helpers.js";

const CREATOR = key("quick/creator");
const IDENTITY = new Uint8Array(32).fill(9);
const SEED = new Uint8Array(32).fill(3);
const NOW = 1_800_000_000n;

let ICON: Uint8Array;
let BIG_ICON: Uint8Array;

beforeAll(async () => {
  const indices = Uint8Array.from({ length: 32 * 32 }, (_, i) => (i * 7) % 4);
  ICON = await encodeIndexedPng({ indices, palette: Uint8Array.of(10, 20, 200, 255, 240, 240, 255, 255, 0, 0, 0, 255, 80, 160, 255, 255) }, 32, 32, 16, { compression: "store" });
  BIG_ICON = await encodeIndexedPng({ indices: new Uint8Array(65 * 65), palette: Uint8Array.of(0, 0, 0, 255) }, 65, 65);
});

function form(over: Partial<QuickLaunchInput> = {}): QuickLaunchInput {
  return {
    name: "Cryo Cat",
    symbol: "CRYO",
    x: "https://x.com/cryocat",
    website: "https://cryo.example",
    description: "A cold cat.",
    iconPng: ICON,
    feeBps: 100,
    feeDestination: "buyback-burn",
    creator: CREATOR,
    identity: IDENTITY,
    launchSeed: SEED,
    ...over,
  };
}

/** The error message `planQuickLaunch` throws (fails the test when it does not throw). */
function refusal(input: QuickLaunchInput): string {
  try {
    planQuickLaunch(input);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    const m = (e as Error).message;
    expect(m.startsWith("invalid quick launch:\n")).toBe(true);
    return m;
  }
  throw new Error("expected planQuickLaunch to refuse");
}

const AUTOPILOT_STEPS = ["set-up-autopilot", "save-autopilot-plan", "approve-autopilot-plan", "switch-on-autopilot", "start-autopilot-plan", "connect-autopilot-token", "connect-autopilot-pool", "daily-buyback"];

/** Words a non-technical creator should never have to read. */
const JARGON =
  /\b(PDAs?|bps|basis points?|PXG1|PXR1|lamports?|wSOL|ATAs?|LMS|LM-OTS|graphs?|hash(es)?|keypairs?|DBC|DAMM|epochs?|params|PQ|attest\w*|post-quantum|identity|pubkeys?|CPI|instructions?|tx|transactions?|numerator|u64|null|undefined|NaN)\b/i;

function userText(q: QuickLaunchPlan): string[] {
  return [...q.summary, ...q.warnings, ...q.steps.flatMap((s) => [s.title, s.detail, s.when])];
}

describe("planQuickLaunch: fee destinations", () => {
  it("wallet: every fee to the creator, no treasury, no autopilot", () => {
    const q = planQuickLaunch(form({ feeDestination: "wallet" }));
    expect(q.recipients).toEqual([{ wallet: CREATOR, bps: 10_000 }]);
    expect(q.params.recipients).toEqual(q.recipients);
    expect(q.treasury).toBeNull();
    expect(q.graph).toBeNull();
    const ids = q.steps.map((s) => s.id);
    for (const id of AUTOPILOT_STEPS) expect(ids).not.toContain(id);
    expect(ids).toEqual(["create-launch", "fund-helper", "save-token-details", "approve-launch", "return-helper-sol", "go-live", "pay-out-fees"]);
    expect(q.steps.find((s) => s.id === "pay-out-fees")!.detail).toContain("your wallet");
    expect(q.summary.join("\n")).toContain("Your share of the trading fees is paid to your wallet.");
    expect(q.summary.join("\n")).not.toContain("autopilot");
  });

  it("buyback-burn: every fee to the launch's autopilot treasury, and the daily buyback-and-burn graph", () => {
    const q = planQuickLaunch(form());
    const launch = launchPdas(CREATOR, SEED).launch;
    expect(q.launch.equals(launch)).toBe(true);
    const treasury = autopilotTreasuryAddress(launch);
    expect(q.treasury!.equals(treasury)).toBe(true);
    expect(q.recipients).toEqual([{ wallet: treasury, bps: 10_000 }]);
    const g = q.graph!;
    expect(g.template).toBe("daily-buyback-burn");
    expect(g.bytes).toEqual(compileGraph(graphTemplate("daily-buyback-burn")));
    const v = verifyGraph(g.bytes);
    expect(v.ok).toBe(true);
    expect(v.ok && v.hash).toEqual(g.hash);
    expect(g.hash).toEqual(graphHash(g.bytes));
    expect(g.bytes.length).toBeLessThanOrEqual(PUBLISH_GRAPH_LEGACY_MAX_BYTES);
    expect(g.publishVia).toBe("legacy");
    expect(g.explanation.length).toBeGreaterThan(0);
    expect(g.explanation.join("\n")).toContain("never sells the token");
    const ids = q.steps.map((s) => s.id);
    expect(ids).toEqual([
      "create-launch",
      "fund-helper",
      "save-token-details",
      "approve-launch",
      "set-up-autopilot",
      "save-autopilot-plan",
      "approve-autopilot-plan",
      "switch-on-autopilot",
      "start-autopilot-plan",
      "return-helper-sol",
      "go-live",
      "connect-autopilot-token",
      "pay-out-fees",
      "connect-autopilot-pool",
      "daily-buyback",
    ]);
    const step = (id: string) => q.steps.find((s) => s.id === id)!;
    expect(step("save-autopilot-plan").sdk).toBe("buildPublishGraphTx");
    expect(step("approve-autopilot-plan")).toMatchObject({ signer: "pq-identity", sdk: "buildPqAuthorizeTx + sendPqAuthorizeTx" });
    expect(step("approve-launch")).toMatchObject({ signer: "pq-identity", sdk: "buildPlannedAttestTx + sendAttestLaunchTx" });
    expect(step("create-launch")).toMatchObject({ signer: "creator-wallet", sdk: "buildPlannedCreateLaunchTx" });
    expect(step("switch-on-autopilot").sdk).toBe("buildActivateTx");
    expect(step("start-autopilot-plan").sdk).toBe("buildApplyPendingTx");
    expect(step("connect-autopilot-token").sdk).toBe("buildBindMintTx");
    expect(step("connect-autopilot-pool").sdk).toBe("buildBindPoolTx");
    expect(step("daily-buyback").sdk).toBe("planKeeperStep / runKeeper");
    expect(step("go-live").sdk).toBe("waitForLaunchWindow + buildPlannedLaunchTx");
    expect(step("pay-out-fees").sdk).toContain("buildDistributeTx");
    expect(q.warnings.some((w) => w.includes("treasury"))).toBe(true);
  });

  it("split: the wallet's share to the creator, the rest to the treasury", () => {
    const q = planQuickLaunch(form({ feeDestination: { split: 3_000 } }));
    const treasury = autopilotTreasuryAddress(q.launch);
    expect(q.recipients).toEqual([
      { wallet: CREATOR, bps: 3_000 },
      { wallet: treasury, bps: 7_000 },
    ]);
    expect(q.treasury!.equals(treasury)).toBe(true);
    expect(q.graph).not.toBeNull();
    expect(q.summary.join("\n")).toContain("30% to your wallet and 70% to your token's autopilot treasury");
    expect(q.steps.find((s) => s.id === "pay-out-fees")!.detail).toContain("your wallet (30%) and the autopilot's treasury (70%)");
    expect(planQuickLaunch(form({ feeDestination: { split: 1 } })).recipients.map((r) => r.bps)).toEqual([1, 9_999]);
    expect(planQuickLaunch(form({ feeDestination: { split: 9_999 } })).recipients.map((r) => r.bps)).toEqual([9_999, 1]);
  });

  it("accepts the identity as a PqIdentity-like object or its 32-byte id", () => {
    const a = planQuickLaunch(form({ identity: { identityId: IDENTITY } }));
    const b = planQuickLaunch(form());
    expect(a.params.pqIdentity).toEqual(IDENTITY);
    expect(launchParamsHash(a.params)).toEqual(launchParamsHash(b.params));
  });
});

describe("planQuickLaunch: parameters and metadata", () => {
  it("the Fair preset with the chosen trading fee, the recipients and the identity; valid for the program", () => {
    for (const feeBps of [25, 100, 250, 833]) {
      for (const feeDestination of ["wallet", "buyback-burn", { split: 5_000 }] as const) {
        const q = planQuickLaunch(form({ feeBps, feeDestination }));
        const pdas = launchPdas(CREATOR, SEED);
        expect(validateLaunchParams(q.params, [pdas.launchAuthority, pdas.batchAuthority])).toEqual({ ok: true, errors: [] });
        const cliff = (BigInt(feeBps) * DBC.FEE_DENOMINATOR) / 10_000n;
        expect(q.params.baseFee).toEqual({ ...PRESETS.fair.params.baseFee, cliffFeeNumerator: cliff });
        expect(q.params.dynamicFee).toEqual(dynamicFeeFor(cliff));
        const { baseFee, dynamicFee, recipients, pqIdentity, ...rest } = q.params;
        const { baseFee: _b, dynamicFee: _d, ...fair } = PRESETS.fair.params;
        expect(rest).toEqual(fair);
        expect([baseFee.cliffFeeNumerator, dynamicFee === null, recipients, pqIdentity]).toEqual([cliff, false, q.recipients, IDENTITY]);
      }
    }
    // The preset itself is untouched.
    expect(PRESETS.fair.params.baseFee.cliffFeeNumerator).toBe(10_000_000n);
  });

  it("the metadata record: the document with the links and the icon, flags 0, and its hash", () => {
    const q = planQuickLaunch(form());
    const doc = buildMetadataDoc({ name: "Cryo Cat", symbol: "CRYO", description: "A cold cat.", iconPng: ICON, links: { website: "https://cryo.example", x: "https://x.com/cryocat" } });
    expect(q.metadata).toEqual({ name: "Cryo Cat", symbol: "CRYO", flags: 0, doc });
    expect(validateTokenMeta(q.metadata).ok).toBe(true);
    expect(q.metadataHash).toEqual(metadataHashV2(q.metadata));
    // Empty links and description are left out.
    const bare = planQuickLaunch(form({ x: "", website: undefined, description: "" }));
    expect(bare.metadata.doc).toEqual(buildMetadataDoc({ name: "Cryo Cat", symbol: "CRYO", iconPng: ICON }));
  });

  it("is deterministic for a given launch seed (and random without one)", () => {
    for (const feeDestination of ["wallet", "buyback-burn", { split: 4_200 }] as const) {
      const a = planQuickLaunch(form({ feeDestination }));
      const b = planQuickLaunch(form({ feeDestination, launchSeed: Uint8Array.from(SEED) }));
      expect(a.launch.equals(b.launch)).toBe(true);
      expect(launchParamsHash(a.params)).toEqual(launchParamsHash(b.params));
      expect([a.metadataHash, a.graph?.bytes, a.graph?.hash, a.summary, a.steps, a.recipients]).toEqual([b.metadataHash, b.graph?.bytes, b.graph?.hash, b.summary, b.steps, b.recipients]);
    }
    const r1 = planQuickLaunch(form({ launchSeed: undefined }));
    const r2 = planQuickLaunch(form({ launchSeed: undefined }));
    expect(r1.launchSeed.length).toBe(32);
    expect(r1.launch.equals(r2.launch)).toBe(false);
    expect(r1.launch.equals(launchPdas(CREATOR, r1.launchSeed).launch)).toBe(true);
    expect(r1.treasury!.equals(autopilotTreasuryAddress(r1.launch))).toBe(true);
  });

  it("launchInput is what planLaunch needs (with the app's opensAt); opensAt also returns that plan", () => {
    const q = planQuickLaunch(form());
    expect(q.plan).toBeNull();
    expect("opensAt" in q.launchInput).toBe(false);
    const opensAt = NOW + 3_600n;
    const viaApp = planLaunch({ ...q.launchInput, opensAt, nowSecs: NOW });
    expect(viaApp.launch.equals(q.launch)).toBe(true);
    expect(viaApp.paramsHash).toEqual(launchParamsHash(q.params));
    expect(viaApp.metadataHash).toEqual(q.metadataHash);

    const withPlan = planQuickLaunch(form({ opensAt, nowSecs: NOW, windowSecs: 1_800n }));
    const plan = withPlan.plan!;
    const expected = planLaunch({ ...withPlan.launchInput, opensAt, nowSecs: NOW });
    expect(plan.window).toEqual({ notBefore: opensAt, notAfter: opensAt + 1_800n });
    expect([plan.launch.toBase58(), plan.paramsHash, plan.metadataHash, plan.message, plan.messageHash, plan.tokenMeta.toBase58()]).toEqual([
      expected.launch.toBase58(),
      expected.paramsHash,
      expected.metadataHash,
      expected.message,
      expected.messageHash,
      expected.tokenMeta.toBase58(),
    ]);
    expect(plan.launch.equals(withPlan.launch)).toBe(true);
    expect(plan.params).toEqual(withPlan.params);
    expect(plan.metadataHash).toEqual(withPlan.metadataHash);
    // Without a clock: the length and the units only.
    expect(planQuickLaunch(form({ opensAt })).plan!.window.notAfter).toBe(opensAt + 3_600n);
  });

  it("refuses a window planLaunch would refuse, listed with the other problems", () => {
    expect(refusal(form({ opensAt: NOW, nowSecs: NOW + 7_200n }))).toMatch(/notAfter: the window ends before/);
    expect(refusal(form({ opensAt: NOW * 1_000n }))).toMatch(/milliseconds/);
    expect(refusal(form({ opensAt: NOW + 3_600n, windowSecs: 10n }))).toMatch(/window must last/);
    expect(refusal(form({ opensAt: 5 as never }))).toMatch(/opensAt: must be bigint unix seconds/);
    const m = refusal(form({ opensAt: NOW, nowSecs: NOW + 7_200n, symbol: "" }));
    expect(m).toMatch(/notAfter:/);
    expect(m).toMatch(/symbol:/);
  });
});

describe("planQuickLaunch: validation", () => {
  it("the trading fee: the program's bounds (0.25% to 8.33% with the busy-market extra)", () => {
    expect(QUICK_LAUNCH_FEE_BPS_RANGE).toEqual({ min: 25, max: 833 });
    expect(planQuickLaunch(form({ feeBps: 25 })).params.baseFee.cliffFeeNumerator).toBe(DBC.MIN_FEE_NUMERATOR);
    expect(planQuickLaunch(form({ feeBps: 833 })).summary.join("\n")).toContain("Trading fee: 8.33% on every buy and sell.");
    expect(refusal(form({ feeBps: 24 }))).toMatch(/feeBps: the trading fee must be from 0\.25% to 8\.33% .*; 0\.24% is too low/);
    expect(refusal(form({ feeBps: 834 }))).toMatch(/feeBps: .*8\.34% is too high/);
    expect(refusal(form({ feeBps: 1_000 }))).toMatch(/10% is too high/);
    expect(refusal(form({ feeBps: 0 }))).toMatch(/feeBps:/);
    expect(refusal(form({ feeBps: -100 }))).toMatch(/feeBps:/);
    expect(refusal(form({ feeBps: 100.5 }))).toMatch(/feeBps: the trading fee must be a whole number/);
    expect(refusal(form({ feeBps: Number.NaN }))).toMatch(/feeBps:/);
    expect(refusal(form({ feeBps: "100" as never }))).toMatch(/feeBps:/);
  });

  it("the fee destination: a split of 1..9,999 bps to the wallet", () => {
    for (const split of [0, 10_000, 2_500.5, -1, 20_000, Number.NaN]) {
      expect(refusal(form({ feeDestination: { split } }))).toMatch(/feeDestination\.split: the wallet's share must be a whole number of bps from 1 to 9999/);
    }
    expect(refusal(form({ feeDestination: "treasury" as never }))).toMatch(/feeDestination: must be "wallet", "buyback-burn" or \{ split/);
    expect(refusal(form({ feeDestination: undefined as never }))).toMatch(/feeDestination:/);
  });

  it("the name, the symbol, the links and the icon", () => {
    expect(refusal(form({ symbol: "" }))).toMatch(/symbol: must be 1\.\.=10 bytes of UTF-8 \(is 0\)/);
    expect(refusal(form({ symbol: "TOOLONGSYMBOL" }))).toMatch(/symbol: must be 1\.\.=10 bytes/);
    expect(refusal(form({ symbol: "€€€€" }))).toMatch(/symbol: .*\(is 12\)/);
    expect(refusal(form({ name: "" }))).toMatch(/name: must be 1\.\.=32 bytes/);
    expect(refusal(form({ name: "n".repeat(33) }))).toMatch(/name: must be 1\.\.=32 bytes/);
    expect(refusal(form({ x: "https://evil.example/cryocat" }))).toMatch(/links\.x: must be a link to x\.com/);
    expect(refusal(form({ website: "http://cryo.example" }))).toMatch(/links\.website: must start with https:\/\//);
    expect(refusal(form({ description: "d".repeat(501) }))).toMatch(/description: must be at most 500/);
    expect(refusal(form({ iconPng: BIG_ICON }))).toMatch(/iconPng: must be at most 64x64 pixels \(is 65x65\)/);
    expect(refusal(form({ iconPng: utf8("<svg/>") }))).toMatch(/iconPng: is not a valid PNG/);
    const noIcon = refusal(form({ iconPng: undefined as never, symbol: "" }));
    expect(noIcon).toMatch(/iconPng: the token's icon is required/);
    expect(noIcon).toMatch(/symbol:/);
  });

  it("the creator, the identity and the launch seed", () => {
    expect(refusal(form({ creator: "creator" as never }))).toMatch(/creator: must be a PublicKey/);
    expect(refusal(form({ identity: new Uint8Array(32) }))).toMatch(/identity: must be/);
    expect(refusal(form({ identity: new Uint8Array(31).fill(1) }))).toMatch(/identity: must be/);
    expect(refusal(form({ identity: {} as never }))).toMatch(/identity: must be/);
    expect(refusal(form({ launchSeed: new Uint8Array(16) }))).toMatch(/launchSeed: must be 32 bytes/);
  });

  it("lists every problem in one error", () => {
    const m = refusal(form({ name: "", symbol: "TOOLONGSYMBOL", feeBps: 2_000, feeDestination: { split: 0 }, iconPng: BIG_ICON, buyback: { premiumBps: 10 }, identity: new Uint8Array(32) }));
    for (const field of ["name:", "symbol:", "feeBps:", "feeDestination.split:", "iconPng:", "buyback.premiumBps:", "identity:"]) expect(m).toContain(field);
    expect(m.split("\n").length).toBeGreaterThanOrEqual(8);
  });

  it("the buyback settings: the template's defaults and ranges, and a premium that covers the pool's fee", () => {
    const t = GRAPH_TEMPLATES.find((x) => x.id === "daily-buyback-burn")!;
    const def = (k: string) => t.params.find((p) => p.key === k)!.default;
    expect(QUICK_LAUNCH_BUYBACK_DEFAULTS).toEqual({ solPerBuyback: def("maxIn"), premiumBps: def("premiumBps"), minTreasurySol: def("minTreasury") });
    expect(QUICK_LAUNCH_BUYBACK_DEFAULTS).toEqual({ solPerBuyback: 0.5, premiumBps: 300, minTreasurySol: 0.5 });
    // The sliders: the template's ranges, the premium from where it covers the Fair pool's 1% fee.
    expect(QUICK_LAUNCH_BUYBACK_RANGES).toEqual({ solPerBuyback: { min: 0.01, max: 100 }, premiumBps: { min: 102, max: 2_000 }, minTreasurySol: { min: 0, max: 1_000 } });
    const range = (k: string) => t.params.find((p) => p.key === k)!.range!;
    expect([range("maxIn").max, range("premiumBps").max, range("minTreasury").min]).toEqual([
      QUICK_LAUNCH_BUYBACK_RANGES.solPerBuyback.max,
      QUICK_LAUNCH_BUYBACK_RANGES.premiumBps.max,
      QUICK_LAUNCH_BUYBACK_RANGES.minTreasurySol.min,
    ]);

    const custom = planQuickLaunch(form({ buyback: { solPerBuyback: 2, premiumBps: 500, minTreasurySol: 3 } }));
    expect(custom.graph!.bytes).toEqual(compileGraph(graphTemplate("daily-buyback-burn", { maxIn: 2, premiumBps: 500, minTreasury: 3 })));
    expect(custom.graph!.bytes).not.toEqual(planQuickLaunch(form()).graph!.bytes);
    expect(custom.summary.join("\n")).toContain("buys back up to 2 SOL of your token and burns it");
    expect(custom.summary.join("\n")).toContain("at least 3 SOL");
    expect(custom.summary.join("\n")).toContain("never pays more than 5% above");
    // The edges of each range build.
    for (const buyback of [
      { solPerBuyback: 0.01, premiumBps: 2_000, minTreasurySol: 0 },
      { solPerBuyback: 100, premiumBps: 102, minTreasurySol: 1_000 },
    ]) {
      const q = planQuickLaunch(form({ feeDestination: { split: 5_000 }, buyback }));
      expect(verifyGraph(q.graph!.bytes).ok).toBe(true);
    }
    expect(planQuickLaunch(form({ buyback: { minTreasurySol: 0 } })).summary.join("\n")).not.toContain("as long as the treasury holds");

    const bad: [QuickLaunchInput["buyback"], RegExp][] = [
      [{ solPerBuyback: 0.001 }, /buyback\.solPerBuyback: must be between 0\.01 and 100 SOL/],
      [{ solPerBuyback: 101 }, /buyback\.solPerBuyback: must be between/],
      [{ solPerBuyback: Number.POSITIVE_INFINITY }, /buyback\.solPerBuyback: must be a number/],
      [{ premiumBps: 49 }, /buyback\.premiumBps: must be between 50 and 2000/],
      [{ premiumBps: 2_001 }, /buyback\.premiumBps: must be between/],
      [{ premiumBps: 300.5 }, /buyback\.premiumBps: must be a whole number/],
      // In the template's range, but below the graduated pool's 1% fee: a buyback could never fill.
      [{ premiumBps: 75 }, /buyback\.premiumBps: must be at least 102 \(1\.02%\): the graduated pool charges a 1% fee/],
      [{ premiumBps: 101 }, /buyback\.premiumBps: must be at least 102/],
      [{ minTreasurySol: -1 }, /buyback\.minTreasurySol: must be between 0 and 1000 SOL/],
      [{ minTreasurySol: 1_001 }, /buyback\.minTreasurySol: must be between/],
      [{ minTreasurySol: "1" as never }, /buyback\.minTreasurySol: must be a number/],
    ];
    for (const [buyback, re] of bad) {
      expect(refusal(form({ buyback })), JSON.stringify(buyback)).toMatch(re);
      expect(refusal(form({ buyback, feeDestination: { split: 100 } }))).toMatch(re);
    }
    // Unused (and not checked) when every fee goes to the wallet.
    const w = planQuickLaunch(form({ feeDestination: "wallet", buyback: { premiumBps: 1 } }));
    expect(w.graph).toBeNull();
    expect(w.warnings).toEqual(["The buyback settings are not used: all of your share of the fees goes to your wallet."]);
  });
});

describe("planQuickLaunch: plain English", () => {
  it("the summary and the steps use no jargon", () => {
    for (const feeDestination of ["wallet", "buyback-burn", { split: 2_500 }] as const) {
      const q = planQuickLaunch(form({ feeDestination, opensAt: NOW + 3_600n, nowSecs: NOW }));
      for (const line of userText(q)) expect(line, line).not.toMatch(JARGON);
      for (const s of q.steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.detail.length).toBeGreaterThan(0);
        expect(s.when.length).toBeGreaterThan(0);
        expect(s.sdk.length).toBeGreaterThan(0);
        expect(["creator-wallet", "throwaway-payer", "anyone", "pq-identity"]).toContain(s.signer);
      }
      expect(new Set(q.steps.map((s) => s.id)).size).toBe(q.steps.length);
    }
  });

  it("says the fee in percent, where the fees go, what the autopilot does, that it never sells, and the safety features", () => {
    const q = planQuickLaunch(form({ feeBps: 150 }));
    const text = q.summary.join("\n");
    expect(text).toContain("Trading fee: 1.5% on every buy and sell. It can rise to at most 1.8% while trading is very busy.");
    expect(text).toContain("Your share of the trading fees goes to your token's autopilot treasury");
    expect(text).toContain("once a day after your token graduates, it buys back up to 0.5 SOL of your token and burns it");
    expect(text).toContain("as long as the treasury holds at least 0.5 SOL");
    expect(text).toContain("never pays more than 3% above");
    expect(text).toContain("The autopilot can never sell your token.");
    expect(text).toContain("72-hour wait");
    expect(text).toContain("85 SOL");
    expect(text).toContain("for the first 5 minutes");
    expect(text).toContain("Each wallet can put in at most 5 SOL.");
    expect(text).toContain("For the first 6 hours after your token goes live, no wallet can hold more than 1% of the supply and no single buy can be more than 0.5% of it.");
    expect(text).toContain("quantum-safe key");
    expect(text).toContain("Nobody, not even you, can create more tokens");
  });
});

describe("planQuickLaunch: inputs it does not keep", () => {
  it("copies the seed and the identity (later changes to the caller's arrays do not change the plan)", () => {
    const seed = Uint8Array.from(SEED);
    const id = Uint8Array.from(IDENTITY);
    const q = planQuickLaunch(form({ launchSeed: seed, identity: id }));
    seed.fill(0);
    id.fill(0);
    expect(q.launchSeed).toEqual(SEED);
    expect(q.params.pqIdentity).toEqual(IDENTITY);
    expect(q.launchInput.launchSeed).toEqual(SEED);
    expect(q.launch.equals(launchPdas(CREATOR, SEED).launch)).toBe(true);
  });

  it("works for any creator wallet", () => {
    const other = Keypair.generate().publicKey;
    const q = planQuickLaunch(form({ creator: other, feeDestination: { split: 6_000 } }));
    expect(q.creator.equals(other)).toBe(true);
    expect(q.recipients[0]!.wallet.equals(other)).toBe(true);
    expect(q.recipients[1]!.wallet.equals(autopilotTreasuryAddress(q.launch))).toBe(true);
    expect(q.launch.equals(launchPdas(other, SEED).launch)).toBe(true);
    expect(PublicKey.isOnCurve(q.treasury!.toBytes())).toBe(false);
  });
});


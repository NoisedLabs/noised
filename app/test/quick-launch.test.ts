/**
 * Quick launch (src/pages/create/quick.ts): the one-screen launch. Every fee stop with every fee destination (and
 * every split) makes parameters the SDK's launch policy accepts, with exactly the fee recipients the person chose:
 * the wallet, the token's own Autopilot treasury (derived from the launch's address before it exists), or both. The
 * "back into the token" buyback is a graph the SDK verifies, never pays anyone and never spends more than it says.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { autopilotTreasuryAddress, launchAddress, launchParamsHash, metadataHashV2, MIGRATION_FEE_TIERS_BPS, planQuickLaunch, POLICY, PRESETS, validateLaunchParams } from "../src/lib/noised";
import { explainGraphLines, graphVerifies, minPremiumBps } from "../src/lib/programmable";
import { convertDraft, iconPng } from "../src/pages/create/draft";
import { generateIcon, seedOf } from "../src/pages/create/pixelIcon";
import {
  buybackBuild,
  buybackGraph,
  DESTINATIONS,
  destinationSentence,
  feeSentence,
  isTreasuryMark,
  launchTreasury,
  needsAutopilot,
  QUICK_BUYBACK,
  QUICK_FEE_STOPS_BPS,
  quickDefaults,
  quickDraft,
  quickPoolFeeBps,
  quickPlanInput,
  quickPremiumBps,
  quickRecipients,
  resolveTreasury,
  SPLIT_STOPS_PCT,
  TREASURY_WALLET,
  type FeeDestination,
  type QuickState,
} from "../src/pages/create/quick";

const creator = Keypair.generate().publicKey;
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pqId = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const { launch, treasury } = launchTreasury(creator, seed);

function quick(over: Partial<QuickState> = {}): QuickState {
  return { ...quickDefaults(), name: "Quick Coin", symbol: "QUIK", ...over };
}

function paramsOf(q: QuickState) {
  const draft = resolveTreasury(quickDraft(q, creator.toBase58()), treasury);
  return convertDraft(draft, pqId, null);
}

describe("quick launch: fee stops and destinations", () => {
  it("offers 0.25% to 5% only", () => {
    expect(QUICK_FEE_STOPS_BPS[0]).toBe(25);
    expect(QUICK_FEE_STOPS_BPS[QUICK_FEE_STOPS_BPS.length - 1]).toBe(500);
    expect(QUICK_FEE_STOPS_BPS.every((b) => b >= 25 && b <= 500)).toBe(true);
    expect(new Set(QUICK_FEE_STOPS_BPS).size).toBe(QUICK_FEE_STOPS_BPS.length);
  });

  it("every fee stop with every destination validates with the SDK, with exactly the chosen recipients", () => {
    let checked = 0;
    for (const feeBps of QUICK_FEE_STOPS_BPS) {
      for (const destination of DESTINATIONS) {
        const splits = destination === "split" ? SPLIT_STOPS_PCT : [50];
        for (const walletPct of splits) {
          const conv = paramsOf(quick({ feeBps, destination, walletPct }));
          const where = `${feeBps} bps, ${destination} ${walletPct}%`;
          expect(conv.inputErrors, where).toEqual({});
          expect(conv.policyErrors, where).toEqual([]);
          const p = conv.params;
          if (p === null) throw new Error("no params");
          expect(validateLaunchParams(p).ok, where).toBe(true);
          // The fee: flat at the stop, with the dynamic part every preset has (at most a fifth more).
          expect(p.baseFee.cliffFeeNumerator, where).toBe(BigInt(feeBps) * 100_000n);
          expect(p.baseFee.firstFactor, where).toBe(0);
          expect(p.dynamicFee, where).not.toBeNull();
          // Everything else is the Fair preset's.
          const fair = PRESETS.fair.params;
          expect([p.openDelaySecs, p.guardSecs, p.maxWalletBps, p.maxBuyBps, p.migrationQuoteThreshold, p.migrationFeeOption, p.batchWalletCap], where).toEqual([
            fair.openDelaySecs,
            fair.guardSecs,
            fair.maxWalletBps,
            fair.maxBuyBps,
            fair.migrationQuoteThreshold,
            fair.migrationFeeOption,
            fair.batchWalletCap,
          ]);
          // The recipients, exactly.
          const got = p.recipients.map((r) => ({ wallet: r.wallet.toBase58(), bps: r.bps }));
          const want =
            destination === "wallet"
              ? [{ wallet: creator.toBase58(), bps: 10_000 }]
              : destination === "token"
                ? [{ wallet: treasury.toBase58(), bps: 10_000 }]
                : [
                    { wallet: creator.toBase58(), bps: walletPct * 100 },
                    { wallet: treasury.toBase58(), bps: (100 - walletPct) * 100 },
                  ];
          expect(got, where).toEqual(want);
          checked++;
        }
      }
    }
    expect(checked).toBe(QUICK_FEE_STOPS_BPS.length * (2 + SPLIT_STOPS_PCT.length));
  });

  it("the treasury is the autopilot program's treasury of this launch's own address, known before it exists", () => {
    expect(launch.equals(launchAddress(creator, seed))).toBe(true);
    expect(treasury.equals(autopilotTreasuryAddress(launch))).toBe(true);
    expect(PublicKey.isOnCurve(treasury.toBytes())).toBe(false);
    // Another seed (another launch) has another treasury: fees can't be routed to someone else's token.
    const other = launchTreasury(creator, Uint8Array.from({ length: 32 }, () => 9));
    expect(other.treasury.equals(treasury)).toBe(false);
  });

  it("the treasury marker never reaches the parameters unresolved", () => {
    const draft = quickDraft(quick({ destination: "token" }), creator.toBase58());
    expect(draft.recipients).toEqual([{ wallet: TREASURY_WALLET, pct: "100" }]);
    const unresolved = convertDraft(draft, pqId, null);
    expect(unresolved.inputErrors["recipients[0].wallet"]).toBe("Not a valid Solana address");
    // Without a creator yet, the treasury can't be known: the field stays empty (a problem), never someone else's.
    expect(resolveTreasury(draft, null).recipients).toEqual([{ wallet: "", pct: "100" }]);
    expect(resolveTreasury(draft, treasury).recipients).toEqual([{ wallet: treasury.toBase58(), pct: "100" }]);
    // A wallet-only draft is left as it is.
    const wallet = quickDraft(quick(), creator.toBase58());
    expect(resolveTreasury(wallet, treasury)).toBe(wallet);
  });

  it("recipients by destination", () => {
    expect(quickRecipients("wallet", 50, "W")).toEqual([{ wallet: "W", pct: "100" }]);
    expect(quickRecipients("token", 50, "W").every(isTreasuryMark)).toBe(true);
    expect(quickRecipients("split", 70, "W")).toEqual([
      { wallet: "W", pct: "70" },
      { wallet: TREASURY_WALLET, pct: "30" },
    ]);
    // Out-of-range splits are clamped so both sides keep a share.
    expect(quickRecipients("split", 0, "W").map((r) => r.pct)).toEqual(["1", "99"]);
    expect(quickRecipients("split", 100, "W").map((r) => r.pct)).toEqual(["99", "1"]);
    expect(DESTINATIONS.filter(needsAutopilot)).toEqual(["token", "split"] satisfies FeeDestination[]);
  });

  it("a quick launch keeps no description and stores its links", () => {
    const q = quick({ meta: { ...quickDefaults().meta, description: "ignored", website: "https://example.org", x: "@noised" } });
    const d = quickDraft(q, creator.toBase58());
    expect(d.meta.description).toBe("");
    expect(d.meta.website).toBe("https://example.org");
    expect(d.preset).toBe("fair");
  });
});

describe("quick launch: the buyback that fees back into the token pay for", () => {
  it("verifies, pays nobody, has no operator, runs once a day after graduation within its limits", () => {
    for (const decimals of [6, 9]) {
      for (const fee of MIGRATION_FEE_TIERS_BPS) {
        const b = buybackBuild(decimals, fee);
        if (!b.ok) throw new Error(b.issues.map((i) => i.message).join("; "));
        expect(graphVerifies(b.bytes)).toBe(true);
        expect(b.graph.recipients).toEqual([]);
        expect(b.graph.operator).toBeNull();
        expect(b.graph.nodes).toHaveLength(1);
        const n = b.graph.nodes[0];
        if (!n) throw new Error("no node");
        expect(n.trigger).toEqual({ kind: "every", secs: QUICK_BUYBACK.everySecs });
        expect(n.action).toEqual({ kind: "buybackBurn", maxInLamports: QUICK_BUYBACK.maxInLamports, maxPremiumBps: quickPremiumBps(fee) });
        // The premium always covers the pool's fee (else a buyback could never fill: review U5).
        expect(quickPremiumBps(fee)).toBeGreaterThanOrEqual(minPremiumBps(fee));
        // At most 0.5 SOL a day, as the sentence says.
        expect(n.budgetPerEpoch).toBeLessThanOrEqual(QUICK_BUYBACK.maxInLamports);
        expect(n.epochSecs).toBe(86_400);
        expect(n.when).toEqual({ op: "and", a: { op: "graduated" }, b: { op: "treasurySolGte", lamports: QUICK_BUYBACK.minTreasuryLamports } });
      }
    }
    expect(quickPoolFeeBps()).toBe(MIGRATION_FEE_TIERS_BPS[PRESETS.fair.params.migrationFeeOption]);
    const lines = explainGraphLines(buybackGraph(6), true).join("\n").toLowerCase();
    expect(lines).toContain("burn");
  });

  it("says plainly what it does and what it means, and nothing for wallet-only fees", () => {
    expect(destinationSentence("wallet", 50, "QUIK")).not.toMatch(/burn|price/i);
    for (const d of ["token", "split"] as const) {
      const s = destinationSentence(d, 60, "QUIK");
      expect(s).toMatch(/buys QUIK back once a day and burns it/);
      expect(s).toMatch(/supports the price and permanently reduces the supply/);
    }
    expect(destinationSentence("split", 60, "QUIK")).toMatch(/^60% of your share goes to your wallet and 40% goes back into QUIK/);
    expect(feeSentence(100)).toMatch(/^Every buy and sell pays 1%: on a 100 SOL trade that is 1 SOL\./);
    expect(feeSentence(25)).toMatch(/0\.25%: on a 100 SOL trade that is 0\.25 SOL/);
    expect(POLICY.MAX_TRADING_FEE_BPS).toBeGreaterThanOrEqual(600);
  });
});

describe("quick launch: the same launch the SDK's planQuickLaunch plans", () => {
  it("every fee stop with every destination gives exactly the SDK's parameters, recipients, treasury and buyback", async () => {
    const icon = await iconPng(generateIcon(seedOf("quick-parity")));
    if (icon === null) throw new Error("no icon");
    let checked = 0;
    for (const feeBps of QUICK_FEE_STOPS_BPS) {
      for (const destination of DESTINATIONS) {
        for (const walletPct of destination === "split" ? SPLIT_STOPS_PCT : [50]) {
          const q = quick({ feeBps, destination, walletPct, meta: { ...quickDefaults().meta, website: "https://example.org", x: "noised" } });
          const where = `${feeBps} bps, ${destination} ${walletPct}%`;
          const conv = convertDraft(resolveTreasury(quickDraft(q, creator.toBase58()), treasury), pqId, icon);
          if (conv.params === null) throw new Error("no params");
          const plan = planQuickLaunch(quickPlanInput(q, { creator, identity: pqId, launchSeed: seed, iconPng: icon }));
          expect(plan.launch.equals(launch), where).toBe(true);
          expect(toHexStr(launchParamsHash(conv.params)), where).toBe(toHexStr(launchParamsHash(plan.params)));
          expect(plan.recipients.map((r) => [r.wallet.toBase58(), r.bps]), where).toEqual(conv.params.recipients.map((r) => [r.wallet.toBase58(), r.bps]));
          expect(plan.treasury?.toBase58() ?? null, where).toBe(destination === "wallet" ? null : treasury.toBase58());
          // The record the quantum key signs: the same bytes.
          expect(toHexStr(metadataHashV2(plan.metadata)), where).toBe(toHexStr(metadataHashV2(conv.metadata)));
          const ours = needsAutopilot(destination) ? buybackBuild(conv.params.tokenDecimal) : null;
          if (ours !== null && !ours.ok) throw new Error("our buyback does not build");
          expect(plan.graph === null ? null : toHexStr(plan.graph.hash), where).toBe(ours === null ? null : toHexStr(ours.hash));
          checked++;
        }
      }
    }
    expect(checked).toBe(QUICK_FEE_STOPS_BPS.length * (2 + SPLIT_STOPS_PCT.length));
  });
});

const toHexStr = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
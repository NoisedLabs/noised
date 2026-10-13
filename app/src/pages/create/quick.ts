/**
 * Quick launch (owner's request, 2026-10-11): the simplest way to launch. One short screen: name, ticker, logo,
 * optional X and website links, the trading fee (a slider over safe stops) and where the fees go:
 *
 *   - "To my wallet": the connected wallet is the only fee recipient;
 *   - "Back into the token": the token's Autopilot treasury is the only fee recipient, and an Autopilot that buys the
 *     token back from its locked pool once a day and burns what it buys is switched on by the creator's quantum key
 *     right after the launch opens (a first autopilot has no waiting period);
 *   - "Split": both, with one slider for the wallet's share.
 *
 * Everything else is the Fair preset (every value passes the launch policy). The pieces compose into the same draft
 * the Custom launch edits (./draft.ts), so the parameters that get validated, hashed and signed come from
 * `convertDraft` exactly as for every launch. test/quick-launch.test.ts runs every fee stop and destination through
 * `convertDraft` and the SDK's `validateLaunchParams`, and the buyback through the SDK's graph verifier.
 *
 * The treasury is a program address derived from the launch's own address (`["treasury", launch]` of the autopilot
 * program), so it is known before the launch exists: the draft carries a marker (`TREASURY_WALLET`) that becomes that
 * address once the launch's seed and creator are known (`resolveTreasury`).
 *
 * Pure functions only.
 */
import { PublicKey } from "@solana/web3.js";

import { autopilotTreasuryAddress, launchAddress, MIGRATION_FEE_TIERS_BPS, PRESETS, type QuickFeeDestination, type QuickLaunchInput } from "../../lib/noised";
import { buildGraph, graphNode, minPremiumBps, type Graph, type GraphBuild } from "../../lib/programmable";
import { draftFromPreset, defaultMeta, xHandle, type Draft, type RecipientDraft, type TokenMetaDraft } from "./draft";
import { FEE_STOPS_BPS, feePatch, pctText } from "./simple";

// ----------------------------------------------------------------- choices ---

/** Where the trading fees go. */
export type FeeDestination = "wallet" | "token" | "split";

export const DESTINATIONS: readonly FeeDestination[] = ["wallet", "token", "split"];

/** Trading fee stops for a quick launch: 0.25% (the pool's floor) to 5%. */
export const QUICK_FEE_STOPS_BPS: readonly number[] = FEE_STOPS_BPS.filter((b) => b <= 500);

/** The wallet's share of the fees in a split, in whole percent (the token's treasury gets the rest). */
export const SPLIT_STOPS_PCT: readonly number[] = [10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90];

export interface QuickState {
  name: string;
  symbol: string;
  /** The logo (an uploaded picture or a pixel icon) and the optional links. The description stays empty in a quick launch. */
  meta: TokenMetaDraft;
  /** The trading fee in bps: one of QUICK_FEE_STOPS_BPS. */
  feeBps: number;
  destination: FeeDestination;
  /** "Split": the wallet's share in whole percent (one of SPLIT_STOPS_PCT). */
  walletPct: number;
}

export function quickDefaults(): QuickState {
  return { name: "", symbol: "", meta: defaultMeta(), feeBps: 100, destination: "wallet", walletPct: 50 };
}

/** The Fair preset every quick launch uses for everything it does not ask. */
export const QUICK_PRESET = "fair" as const;

// --------------------------------------------------------------- treasury ---

/** Marker of "this token's Autopilot treasury" in a draft's recipients (replaced by its address before launch). */
export const TREASURY_WALLET = "this-token's-autopilot-treasury";

export const isTreasuryMark = (r: Pick<RecipientDraft, "wallet">): boolean => r.wallet === TREASURY_WALLET;

/** The launch's address and its Autopilot treasury, from the creator and the launch's 32-byte seed. */
export function launchTreasury(creator: PublicKey, launchSeed: Uint8Array): { launch: PublicKey; treasury: PublicKey } {
  const launch = launchAddress(creator, launchSeed);
  return { launch, treasury: autopilotTreasuryAddress(launch) };
}

/** The draft with the treasury marker replaced by the treasury's address (unchanged when there is no marker). */
export function resolveTreasury(d: Draft, treasury: PublicKey | null): Draft {
  if (!d.recipients.some(isTreasuryMark)) return d;
  return { ...d, recipients: d.recipients.map((r) => (isTreasuryMark(r) ? { ...r, wallet: treasury === null ? "" : treasury.toBase58() } : r)) };
}

/** Whether the draft sends any fees to the token's own treasury. */
export const sendsFeesToTreasury = (d: Pick<Draft, "recipients">): boolean => d.recipients.some(isTreasuryMark);

/** The fee recipients a destination makes: the wallet (as typed: "" when none is connected) and / or the treasury marker. */
export function quickRecipients(destination: FeeDestination, walletPct: number, wallet: string): RecipientDraft[] {
  if (destination === "wallet") return [{ wallet, pct: "100" }];
  if (destination === "token") return [{ wallet: TREASURY_WALLET, pct: "100" }];
  const w = Math.max(1, Math.min(99, Math.round(walletPct)));
  return [
    { wallet, pct: String(w) },
    { wallet: TREASURY_WALLET, pct: String(100 - w) },
  ];
}

/** The quick launch as the wizard's draft: the Fair preset, the fee stop, the name, symbol, logo and links, the recipients. */
export function quickDraft(q: QuickState, wallet: string): Draft {
  const base = draftFromPreset(QUICK_PRESET, { name: q.name, symbol: q.symbol, meta: { ...q.meta, description: "" }, recipients: quickRecipients(q.destination, q.walletPct, wallet) });
  return { ...base, ...feePatch(q.feeBps) };
}

/** The treasury's share of the creator's fees in a draft, in whole percent (0: none). */
export function treasuryShareOf(recipients: readonly RecipientDraft[]): number {
  return recipients.filter(isTreasuryMark).reduce((s, r) => s + (Number(r.pct) || 0), 0);
}

/**
 * The recipients with the treasury taking `pct` whole percent (0 removes it, 100 leaves only it); the other recipients
 * keep their order and relative shares in the rest, to two decimals, the last one taking the rounding. With nobody
 * else, the wallet `fallback` (the connected one) takes the rest.
 */
export function withTreasuryShare(recipients: readonly RecipientDraft[], pct: number, fallback: string): RecipientDraft[] {
  const share = Math.max(0, Math.min(100, Math.round(pct)));
  const others = recipients.filter((r) => !isTreasuryMark(r));
  const rest = 100 - share;
  if (share === 0) return others.length > 0 ? scaleTo(others, 100) : [{ wallet: fallback, pct: "100" }];
  if (rest === 0) return [{ wallet: TREASURY_WALLET, pct: "100" }];
  const base = others.length > 0 ? others : [{ wallet: fallback, pct: "100" }];
  return [...scaleTo(base, rest), { wallet: TREASURY_WALLET, pct: String(share) }];
}

/** Shares scaled to add up to `total` percent exactly (in hundredths), the last one taking the rounding. */
function scaleTo(rs: readonly RecipientDraft[], total: number): RecipientDraft[] {
  const weights = rs.map((r) => Math.max(0, Number(r.pct) || 0));
  const sum = weights.reduce((a, b) => a + b, 0);
  const hundredths = total * 100;
  let left = hundredths;
  return rs.map((r, i) => {
    const h = i === rs.length - 1 ? left : Math.floor((sum > 0 ? (weights[i] ?? 0) / sum : 1 / rs.length) * hundredths);
    left -= h;
    return { ...r, pct: pctText(h) };
  });
}

/** Whether a destination needs the Autopilot (the treasury and its buyback). */
export const needsAutopilot = (d: FeeDestination): boolean => d !== "wallet";

// --------------------------------------------------------------- buyback ---

const SOL = 1_000_000_000n;
const DAY = 86_400;

/** The buyback a "back into the token" launch runs: once a day, up to this much SOL, once the treasury holds at least the minimum. */
export const QUICK_BUYBACK = {
  everySecs: DAY,
  maxInLamports: SOL / 2n,
  minTreasuryLamports: SOL / 20n,
} as const;

/** The pool's fee after graduation for the Fair preset (what every buyback pays). */
export const quickPoolFeeBps = (): number => MIGRATION_FEE_TIERS_BPS[PRESETS[QUICK_PRESET].params.migrationFeeOption] ?? 100;

/** The most a buyback pays above the recent low price: 3%, or the least the pool's fee needs to ever fill (review U5). */
export const quickPremiumBps = (poolFeeBps: number): number => Math.max(300, minPremiumBps(poolFeeBps));

/**
 * "Buy back and burn, every day": the token's Autopilot steps for fees routed back into the token. Only after the token
 * graduates (its liquidity is then in the locked pool the buyback buys from), only when the treasury holds at least
 * 0.05 SOL, at most 0.5 SOL a day, and never more than 3% above the recent low price. Every token it buys is burned in
 * the same step. Nobody operates it: anyone may run it when it is due (and earns the program's small tip).
 */
export function buybackGraph(decimals: number, poolFeeBps: number = quickPoolFeeBps()): Graph {
  return {
    operator: null,
    recipients: [],
    nodes: [
      graphNode(
        "buyback",
        { kind: "every", secs: QUICK_BUYBACK.everySecs },
        { op: "and", a: { op: "graduated" }, b: { op: "treasurySolGte", lamports: QUICK_BUYBACK.minTreasuryLamports } },
        { kind: "buybackBurn", maxInLamports: QUICK_BUYBACK.maxInLamports, maxPremiumBps: quickPremiumBps(poolFeeBps) },
        { epochSecs: DAY },
        decimals,
      ),
    ],
    tokenDecimals: decimals,
  };
}

/** The buyback's PXG1 bytes and fingerprint (what the quantum key signs after the launch opens). */
export function buybackBuild(decimals: number, poolFeeBps?: number): GraphBuild {
  return buildGraph(buybackGraph(decimals, poolFeeBps));
}

// ------------------------------------------------------------- the SDK ---

/** The destination as the SDK's `planQuickLaunch` takes it (the split: the wallet's share in bps). */
export function sdkDestination(d: FeeDestination, walletPct: number): QuickFeeDestination {
  if (d === "wallet") return "wallet";
  if (d === "token") return "buyback-burn";
  return { split: Math.max(1, Math.min(99, Math.round(walletPct))) * 100 };
}

/**
 * The quick launch as the SDK's `planQuickLaunch` input (SDK 0.7.0): the same form, with this app's buyback settings
 * (0.5 SOL a day, the premium the pool's fee needs, from 0.05 SOL in the treasury).
 */
export function quickPlanInput(q: QuickState, who: { creator: PublicKey; identity: Uint8Array; launchSeed: Uint8Array; iconPng: Uint8Array }): QuickLaunchInput {
  const x = xHandle(q.meta);
  return {
    name: q.name,
    symbol: q.symbol,
    x: x === "" ? "" : `https://x.com/${x}`,
    website: q.meta.website.trim(),
    iconPng: who.iconPng,
    feeBps: q.feeBps,
    feeDestination: sdkDestination(q.destination, q.walletPct),
    creator: who.creator,
    identity: who.identity,
    launchSeed: who.launchSeed,
    buyback: { solPerBuyback: Number(QUICK_BUYBACK.maxInLamports) / 1e9, premiumBps: quickPremiumBps(quickPoolFeeBps()), minTreasurySol: Number(QUICK_BUYBACK.minTreasuryLamports) / 1e9 },
  };
}

// -------------------------------------------------------------- sentences ---

/** "1%": the fee as the slider shows it. */
export const feeText = (bps: number): string => `${pctText(bps)}%`;

/** What the fee means, in one plain sentence. */
export function feeSentence(bps: number): string {
  const per100 = (bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `Every buy and sell pays ${feeText(bps)}: on a 100 SOL trade that is ${per100} SOL. A small part goes to Noised; the rest goes where you choose below.`;
}

/** The destination cards' titles and one-line explanations. */
export const DESTINATION_TEXT: Record<FeeDestination, { title: string; line: string }> = {
  wallet: { title: "To my wallet", line: "Your share of the fees is paid to the wallet you launch from." },
  token: {
    title: "Back into the token",
    line: "Buy back & burn automatically: once a day the token's treasury buys it back from its locked pool and burns it.",
  },
  split: { title: "Split", line: "Part to your wallet, part back into the token. You pick the split." },
};

/** The plain sentence under the destination cards (the fee hook in one line, no jargon). */
export function destinationSentence(d: FeeDestination, walletPct: number, symbol: string): string {
  const s = symbol.trim() === "" ? "your token" : symbol.trim();
  const buyback = `${s}'s own treasury buys ${s} back once a day and burns it, which supports the price and permanently reduces the supply`;
  if (d === "wallet") return "Your share of every fee is paid to your wallet. Nothing runs automatically.";
  if (d === "token") return `Your share of every fee goes back into ${s}: ${buyback}. You receive none of it.`;
  const w = Math.max(1, Math.min(99, Math.round(walletPct)));
  return `${w}% of your share goes to your wallet and ${100 - w}% goes back into ${s}: ${buyback}.`;
}

/** The honest small print of the buyback (shown under the destination). */
export function buybackFacts(poolFeeBps: number = quickPoolFeeBps()): string[] {
  return [
    "It starts once the token graduates and its liquidity is locked in its pool. Until then the fees wait in the treasury.",
    `At most 0.5 SOL a day, and never more than ${pctText(quickPremiumBps(poolFeeBps))}% above the recent low price.`,
    "It can only buy the token and burn it: it can never sell, pull liquidity or pay anyone.",
    "Your quantum key switches it on right after the launch opens. Anyone can run it when it is due, so it keeps going without you.",
  ];
}

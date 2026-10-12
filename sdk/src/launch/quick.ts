/**
 * Quick launch: a whole launch planned from a short form (name, symbol,
 * icon, links, the trading fee and where the creator's share of the fees
 * goes), for a simple UI.
 *
 * `planQuickLaunch` is pure: it fixes the Fair preset with the chosen
 * trading fee, the fee recipients (the creator's wallet, the launch's own
 * autopilot treasury, or a split of the two), the token's metadata record,
 * and, when fees go to the treasury, the autopilot's daily buyback-and-burn
 * graph; it lists the steps the app runs, in order, with the SDK function(s)
 * behind each, and plain-English lines for the creator. Nothing is signed
 * or sent here.
 *
 * Fee routing: `distribute` (permissionless) pays the creator's share of
 * trading fees to the launch's fee recipients at ATA(wallet, wSOL). The
 * treasury `["treasury", launch]` (autopilot program) is an off-curve PDA
 * whose wSOL account only an autopilot graph activated by the launch's
 * post-quantum identity can spend (buy back and burn, burn, pay the graph's
 * recipients, keeper tips); the treasury can never sell the token. A first
 * graph may take effect at once (`activate_at >= now`); later changes wait
 * the 72-hour timelock.
 */
import { PublicKey } from "@solana/web3.js";

import { PUBLISH_GRAPH_LEGACY_MAX_BYTES } from "../autopilot/builders.js";
import { isAllZero, randomBytes } from "../codec/bytes.js";
import { DBC, MIGRATION_FEE_TIERS_BPS, POLICY } from "../constants.js";
import { buildMetadataDoc, validateMetadataDoc, type MetadataDocInput } from "../metadata/doc.js";
import { metadataHashV2, validateTokenMeta, type TokenMetaInput } from "../metadata/record.js";
import { autopilotTreasuryAddress, launchPdas } from "../pda.js";
import type { PqIdentity } from "../pq/identity.js";
import { AUTOPILOT } from "../programmable/constants.js";
import { verifyGraph } from "../programmable/graph/codec.js";
import { explainGraph } from "../programmable/graph/explain.js";
import { minPremiumForFee } from "../programmable/graph/market.js";
import { compileGraph } from "../programmable/graph/model.js";
import { graphHash } from "../programmable/hash.js";
import { GRAPH_TEMPLATES, graphTemplate } from "../programmable/templates.js";
import { formatDurationLong, formatSol, toLamports } from "../programmable/units.js";
import type { FeeRecipient, LaunchParams } from "../types.js";
import { planLaunch, type LaunchPlan, type PlanLaunchInput } from "./flow.js";
import { feeSummary, validateLaunchParams } from "./policy.js";
import { dynamicFeeFor, PRESETS } from "./presets.js";
import { checkNowSecs, plausibleUnixSecs, validateLaunchWindow } from "./window.js";

// ---------------------------------------------------------------- types ---

/**
 * Where the creator's share of the trading fees goes: all to the creator's
 * wallet, all to the launch's autopilot treasury (daily buyback and burn),
 * or `{ split }`: `split` bps (1..=9,999) to the wallet, the rest to the
 * treasury.
 */
export type QuickFeeDestination = "wallet" | "buyback-burn" | { readonly split: number };

/** The daily buyback's settings (the `daily-buyback-burn` template's `maxIn`, `premiumBps`, `minTreasury`). */
export interface QuickBuybackOptions {
  /** SOL spent per daily buyback (template range 0.01..=100). */
  readonly solPerBuyback?: number | undefined;
  /** The most a buyback pays above the recent low price, in bps (template range 50..=2,000; at least what covers the pool's fee). */
  readonly premiumBps?: number | undefined;
  /** Buy back only while the treasury holds at least this much SOL (template range 0..=1,000). */
  readonly minTreasurySol?: number | undefined;
}

/** `planQuickLaunch` input: the quick-launch form. */
export interface QuickLaunchInput {
  /** 1..=32 bytes of UTF-8. */
  readonly name: string;
  /** 1..=10 bytes of UTF-8. */
  readonly symbol: string;
  /** An `https://x.com/…` link (empty: none). */
  readonly x?: string | undefined;
  /** An `https://` link (empty: none). */
  readonly website?: string | undefined;
  /** At most 500 bytes of UTF-8. */
  readonly description?: string | undefined;
  /** A PNG of at most 64x64 pixels (`encodeIndexedPng`). */
  readonly iconPng: Uint8Array;
  /** The trading fee in bps (100 = 1%): `QUICK_LAUNCH_FEE_BPS_RANGE`, the program's bounds (`validateLaunchParams`). */
  readonly feeBps: number;
  readonly feeDestination: QuickFeeDestination;
  /** The wallet that signs create_launch (and receives the wallet share of the fees). */
  readonly creator: PublicKey;
  /** The creator's post-quantum identity (`deriveIdentity`), or its 32-byte id. */
  readonly identity: Pick<PqIdentity, "identityId"> | Uint8Array;
  /** 32 bytes (default random). */
  readonly launchSeed?: Uint8Array | undefined;
  /** When the launch window opens, unix SECONDS: also returns the full `LaunchPlan` (`planLaunch`). */
  readonly opensAt?: bigint | undefined;
  /** Window length in seconds, 60..=3,600 (default 3,600). */
  readonly windowSecs?: bigint | undefined;
  /** Bigint unix seconds to check the window against (`clusterUnixTime`); omitted: its length and units only. */
  readonly nowSecs?: bigint | undefined;
  /** The daily buyback's settings (default `QUICK_LAUNCH_BUYBACK_DEFAULTS`); used unless the fees all go to the wallet. */
  readonly buyback?: QuickBuybackOptions | undefined;
}

/** Who signs (or sends) a step. */
export type QuickLaunchSigner = "creator-wallet" | "throwaway-payer" | "anyone" | "pq-identity";

/** One step of the launch, for the app to run and show. */
export interface QuickLaunchStep {
  readonly id: string;
  /** Plain English, for the creator. */
  readonly title: string;
  /** Plain English, for the creator. */
  readonly detail: string;
  readonly signer: QuickLaunchSigner;
  /** The SDK function(s) the app calls. */
  readonly sdk: string;
  /** Plain English: when the step happens. */
  readonly when: string;
}

/** The autopilot's daily buyback-and-burn graph. */
export interface QuickLaunchGraph {
  readonly template: "daily-buyback-burn";
  /** PXG1 bytes (`compileGraph`; verified). */
  readonly bytes: Uint8Array;
  /** `graphHash(bytes)`. */
  readonly hash: Uint8Array;
  /** `explainGraph`: plain English. */
  readonly explanation: string[];
  /** `legacy` (`buildPublishGraphTx`) when it fits a legacy transaction, else `v1` (`buildPublishGraphV1Tx`). */
  readonly publishVia: "legacy" | "v1";
}

/** `planQuickLaunch` result. */
export interface QuickLaunchPlan {
  readonly launch: PublicKey;
  readonly launchSeed: Uint8Array;
  readonly creator: PublicKey;
  /** The Fair preset with the chosen trading fee, the recipients and the identity (validated like the program). */
  readonly params: LaunchParams;
  readonly recipients: FeeRecipient[];
  /** The launch's autopilot treasury (`autopilotTreasuryAddress(launch)`) when it receives fees, else null. */
  readonly treasury: PublicKey | null;
  /** The token's metadata record (flags 0: the mint's uri stays empty). */
  readonly metadata: TokenMetaInput;
  /** `metadataHashV2(metadata)`. */
  readonly metadataHash: Uint8Array;
  /** What the app passes to `planLaunch`, with its chosen `opensAt`. */
  readonly launchInput: Omit<PlanLaunchInput, "opensAt">;
  /** `planLaunch({ ...launchInput, opensAt })` when `opensAt` was given, else null. */
  readonly plan: LaunchPlan | null;
  /** The autopilot's graph (null when the fees all go to the wallet). */
  readonly graph: QuickLaunchGraph | null;
  readonly steps: QuickLaunchStep[];
  /** Plain-English lines for the creator. */
  readonly summary: string[];
  /** Plain-English cautions. */
  readonly warnings: string[];
}

// ------------------------------------------------------------ constants ---

const BPS = POLICY.BPS_DENOMINATOR;
const FAIR = PRESETS.fair.params;
const BUYBACK_TEMPLATE = GRAPH_TEMPLATES.find((t) => t.id === "daily-buyback-burn");
if (BUYBACK_TEMPLATE === undefined) throw new Error("the daily-buyback-burn graph template is missing");

function templateParam(key: string): { default: number; range: { min: number; max: number } } {
  const p = BUYBACK_TEMPLATE!.params.find((x) => x.key === key);
  if (p === undefined || typeof p.default !== "number" || p.range === undefined) throw new Error(`the daily-buyback-burn template has no numeric "${key}"`);
  return { default: p.default, range: { min: p.range.min, max: p.range.max } };
}

const MAX_IN = templateParam("maxIn");
const PREMIUM = templateParam("premiumBps");
const MIN_TREASURY = templateParam("minTreasury");

/** The daily buyback's settings, every one given. */
export interface QuickBuybackSettings {
  readonly solPerBuyback: number;
  readonly premiumBps: number;
  readonly minTreasurySol: number;
}

/** The daily buyback's defaults: the `daily-buyback-burn` template's (0.5 SOL a day, at most 3% above the recent low, only with 0.5 SOL in the treasury). */
export const QUICK_LAUNCH_BUYBACK_DEFAULTS: QuickBuybackSettings = Object.freeze({
  solPerBuyback: MAX_IN.default,
  premiumBps: PREMIUM.default,
  minTreasurySol: MIN_TREASURY.default,
});

/** The graduated pool's fee (the Fair preset's DAMM v2 fee tier) and the least buyback premium that covers it (`minPremiumForFee`). */
const POOL_FEE_BPS = MIGRATION_FEE_TIERS_BPS[FAIR.migrationFeeOption];
if (POOL_FEE_BPS === undefined) throw new Error("the Fair preset names an unknown migration fee option");
const MIN_COVERING_PREMIUM = minPremiumForFee(POOL_FEE_BPS);

/**
 * The buyback settings `planQuickLaunch` accepts, for the app's sliders:
 * the template's ranges, with the premium starting where it covers the
 * graduated pool's 1% fee (102 bps; a lower one could never fill).
 */
export const QUICK_LAUNCH_BUYBACK_RANGES: {
  readonly solPerBuyback: { readonly min: number; readonly max: number };
  readonly premiumBps: { readonly min: number; readonly max: number };
  readonly minTreasurySol: { readonly min: number; readonly max: number };
} = Object.freeze({
  solPerBuyback: Object.freeze({ ...MAX_IN.range }),
  premiumBps: Object.freeze({ min: Math.max(PREMIUM.range.min, MIN_COVERING_PREMIUM), max: PREMIUM.range.max }),
  minTreasurySol: Object.freeze({ ...MIN_TREASURY.range }),
});

/** The Fair preset's parameters with a flat trading fee of `feeBps` (and its dynamic fee), without recipients or identity. */
function fairWithFee(feeBps: number): Omit<LaunchParams, "recipients" | "pqIdentity"> {
  const cliffFeeNumerator = (BigInt(feeBps) * DBC.FEE_DENOMINATOR) / BigInt(BPS);
  return {
    ...FAIR,
    curve: FAIR.curve.map((c) => ({ sqrtPrice: c.sqrtPrice, liquidity: c.liquidity })),
    baseFee: { ...FAIR.baseFee, cliffFeeNumerator },
    dynamicFee: dynamicFeeFor(cliffFeeNumerator),
  };
}

/** Whether a quick launch with this fee passes `validateLaunchParams` (everything else valid). */
function feeAccepted(feeBps: number): boolean {
  const filler = new PublicKey(new Uint8Array(32).fill(7));
  return validateLaunchParams({ ...fairWithFee(feeBps), recipients: [{ wallet: filler, bps: BPS }], pqIdentity: new Uint8Array(32).fill(7) }).ok;
}

function feeRange(): { readonly min: number; readonly max: number } {
  let min = 1;
  while (min <= POLICY.MAX_TRADING_FEE_BPS && !feeAccepted(min)) min++;
  let max = POLICY.MAX_TRADING_FEE_BPS;
  while (max >= min && !feeAccepted(max)) max--;
  if (min > max) throw new Error("no trading fee passes the launch policy");
  return Object.freeze({ min, max });
}

/**
 * The trading fees (bps) a quick launch accepts: at least 0.25% (DBC's
 * minimum), and at most what keeps the fee plus its busy-market extra (up to
 * 20% more, `dynamicFeeFor`) within the 10% ceiling: 25..=833.
 */
export const QUICK_LAUNCH_FEE_BPS_RANGE: { readonly min: number; readonly max: number } = feeRange();

// ------------------------------------------------------------- helpers ---

/** 100 -> "1%", 125 -> "1.25%", 50 -> "0.5%". */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** A fee numerator (of 1e9) as a percentage, two decimals at most. */
function pctOfNumerator(n: bigint): string {
  return `${(Number(n) / Number(DBC.FEE_DENOMINATOR / 100n)).toFixed(2).replace(/\.?0+$/, "")}%`;
}

const solText = (lamports: bigint): string => `${formatSol(lamports, true)} SOL`;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The daily buyback's settings, checked against the template's ranges and the graduated pool's fee. */
function buybackSettings(input: QuickBuybackOptions | undefined, errors: string[]): QuickBuybackSettings {
  const o = input ?? {};
  if (o === null || typeof o !== "object") {
    errors.push("buyback: must be an object ({ solPerBuyback, premiumBps, minTreasurySol })");
    return { ...QUICK_LAUNCH_BUYBACK_DEFAULTS };
  }
  const out = {
    solPerBuyback: o.solPerBuyback ?? QUICK_LAUNCH_BUYBACK_DEFAULTS.solPerBuyback,
    premiumBps: o.premiumBps ?? QUICK_LAUNCH_BUYBACK_DEFAULTS.premiumBps,
    minTreasurySol: o.minTreasurySol ?? QUICK_LAUNCH_BUYBACK_DEFAULTS.minTreasurySol,
  };
  const inRange = (field: string, v: unknown, r: { min: number; max: number }, unit: string, integer: boolean): boolean => {
    if (!isNumber(v) || (integer && !Number.isInteger(v))) {
      errors.push(`buyback.${field}: must be ${integer ? "a whole number" : "a number"} (${unit})`);
      return false;
    }
    if (v < r.min || v > r.max) {
      errors.push(`buyback.${field}: must be between ${r.min} and ${r.max} ${unit} (is ${v})`);
      return false;
    }
    return true;
  };
  inRange("solPerBuyback", out.solPerBuyback, MAX_IN.range, "SOL", false);
  // A premium below fee / (1 - fee) never fills on the graduated pool, whatever the amount (`premiumCoversFee`).
  if (inRange("premiumBps", out.premiumBps, PREMIUM.range, "bps", true) && out.premiumBps < MIN_COVERING_PREMIUM) {
    errors.push(
      `buyback.premiumBps: must be at least ${MIN_COVERING_PREMIUM} (${pct(MIN_COVERING_PREMIUM)}): the graduated pool charges a ${pct(POOL_FEE_BPS!)} fee, so a buyback limited to ${pct(out.premiumBps)} above the recent low price could never go through`,
    );
  }
  inRange("minTreasurySol", out.minTreasurySol, MIN_TREASURY.range, "SOL", false);
  return out;
}

/** The window `planLaunch` will check, every problem listed (the same checks, so the plan below cannot fail on it). */
function windowErrors(opensAt: unknown, windowSecs: unknown, nowSecs: unknown): string[] {
  if (typeof opensAt !== "bigint") return ["opensAt: must be bigint unix seconds"];
  const length = windowSecs ?? BigInt(POLICY.MAX_LAUNCH_WINDOW_SECS);
  if (typeof length !== "bigint") return ["windowSecs: must be a bigint number of seconds"];
  let now: bigint;
  if (nowSecs === undefined) {
    // As `planLaunch` without a clock: the length and the units only.
    now = plausibleUnixSecs(opensAt - 1n) ? opensAt - 1n : 0n;
  } else {
    try {
      now = checkNowSecs(nowSecs, "nowSecs");
    } catch (e) {
      return [`nowSecs: ${(e as Error).message}`];
    }
  }
  try {
    return validateLaunchWindow(opensAt, opensAt + length, nowSecs === undefined ? { nowSecs: now, landingMarginSecs: 0n } : { nowSecs: now }).errors;
  } catch (e) {
    return [`opensAt: ${(e as Error).message}`];
  }
}

// ------------------------------------------------------------------ plan ---

/**
 * Plan a quick launch from its form: the Fair preset with the chosen
 * trading fee, the fee recipients (`wallet`: the creator; `buyback-burn`:
 * the launch's autopilot treasury; `{ split }`: both), the metadata record
 * (`buildMetadataDoc` with the links and the icon), the autopilot's daily
 * buyback-and-burn graph when the treasury receives fees, the steps for
 * the app and plain-English lines for the creator. With `opensAt`, also
 * the full `LaunchPlan`. Pure and synchronous (deterministic for a given
 * `launchSeed`). Throws one Error listing every problem.
 */
export function planQuickLaunch(input: QuickLaunchInput): QuickLaunchPlan {
  if (input === null || typeof input !== "object") throw new TypeError("planQuickLaunch takes the quick-launch form as an object");
  const errors: string[] = [];
  const warnings: string[] = [];

  // Who and which launch.
  const creatorOk = input.creator instanceof PublicKey;
  if (!creatorOk) errors.push("creator: must be a PublicKey (the wallet that creates the launch)");
  const rawId = input.identity instanceof Uint8Array ? input.identity : input.identity?.identityId;
  const pqIdentity = rawId instanceof Uint8Array ? Uint8Array.from(rawId) : new Uint8Array(0);
  if (pqIdentity.length !== 32 || isAllZero(pqIdentity)) errors.push("identity: must be the creator's post-quantum identity, or its 32-byte, non-zero id");
  const launchSeed = input.launchSeed === undefined ? randomBytes(32) : input.launchSeed instanceof Uint8Array ? Uint8Array.from(input.launchSeed) : new Uint8Array(0);
  if (launchSeed.length !== 32) errors.push("launchSeed: must be 32 bytes");
  const pdas = creatorOk && launchSeed.length === 32 ? launchPdas(input.creator, launchSeed) : null;

  // Where the fees go.
  const dest = input.feeDestination;
  let walletBps: number | null = null;
  let toTreasury = false;
  if (dest === "wallet") walletBps = BPS;
  else if (dest === "buyback-burn") {
    walletBps = 0;
    toTreasury = true;
  } else if (dest !== null && typeof dest === "object" && "split" in dest) {
    const w = dest.split;
    if (!Number.isInteger(w) || w < 1 || w >= BPS) {
      errors.push(`feeDestination.split: the wallet's share must be a whole number of bps from 1 to ${BPS - 1} (use "wallet" for all of it, "buyback-burn" for none)`);
    } else walletBps = w;
    toTreasury = true;
  } else errors.push('feeDestination: must be "wallet", "buyback-burn" or { split: <the wallet\'s share in bps> }');
  const treasury = toTreasury && pdas !== null ? autopilotTreasuryAddress(pdas.launch) : null;
  const recipients: FeeRecipient[] = [];
  if (walletBps !== null && walletBps > 0 && creatorOk) recipients.push({ wallet: input.creator, bps: walletBps });
  if (walletBps !== null && walletBps < BPS && treasury !== null) recipients.push({ wallet: treasury, bps: BPS - walletBps });

  // The trading fee and the parameters, validated exactly like the program (the launch's own PDAs may not receive fees).
  const { min: minFee, max: maxFee } = QUICK_LAUNCH_FEE_BPS_RANGE;
  const feeBps = input.feeBps;
  let params: LaunchParams | null = null;
  if (!Number.isSafeInteger(feeBps)) {
    errors.push(`feeBps: the trading fee must be a whole number of bps, from ${minFee} (${pct(minFee)}) to ${maxFee} (${pct(maxFee)})`);
  } else {
    params = { ...fairWithFee(feeBps), recipients, pqIdentity };
    const v = validateLaunchParams(params, pdas === null ? [] : [pdas.launchAuthority, pdas.batchAuthority]);
    const feeProblems = v.errors.filter((e) => e.startsWith("baseFee") || e.startsWith("dynamicFee"));
    if (feeProblems.length > 0) {
      const why = feeBps < minFee ? "too low" : feeBps > maxFee ? "too high" : `refused (${feeProblems.join("; ")})`;
      errors.push(
        `feeBps: the trading fee must be from ${pct(minFee)} to ${pct(maxFee)} (${minFee} to ${maxFee} bps: with the busy-market extra it stays within the ${pct(POLICY.MAX_TRADING_FEE_BPS)} ceiling); ${pct(feeBps)} is ${why}`,
      );
    }
    // The identity, and the recipients when the creator or the destination is wrong, are reported above already.
    const reported = (e: string): boolean => feeProblems.includes(e) || e.startsWith("pqIdentity") || (e.startsWith("recipients") && (walletBps === null || !creatorOk || pdas === null));
    errors.push(...v.errors.filter((e) => !reported(e)));
  }

  // The token's metadata record.
  const iconOk = input.iconPng instanceof Uint8Array;
  if (!iconOk) errors.push("iconPng: the token's icon is required (a PNG of at most 64x64 pixels)");
  const docInput: MetadataDocInput = {
    name: input.name,
    symbol: input.symbol,
    description: input.description === "" ? undefined : input.description,
    iconPng: iconOk ? input.iconPng : undefined,
    links: { website: input.website === "" ? undefined : input.website, x: input.x === "" ? undefined : input.x },
  };
  const d = validateMetadataDoc(docInput);
  errors.push(...d.errors);
  let metadata: TokenMetaInput | null = null;
  if (d.ok && iconOk) {
    metadata = { name: input.name, symbol: input.symbol, flags: 0, doc: buildMetadataDoc(docInput) };
    errors.push(...validateTokenMeta(metadata).errors);
  }

  // The autopilot's graph (the buyback settings are not used when every fee goes to the wallet).
  const buyback = dest === "wallet" ? { ...QUICK_LAUNCH_BUYBACK_DEFAULTS } : buybackSettings(input.buyback, errors);
  if (dest === "wallet" && input.buyback !== undefined) warnings.push("The buyback settings are not used: all of your share of the fees goes to your wallet.");
  let graph: QuickLaunchGraph | null = null;
  if (toTreasury && !errors.some((e) => e.startsWith("buyback"))) {
    try {
      const g = graphTemplate("daily-buyback-burn", { maxIn: buyback.solPerBuyback, premiumBps: buyback.premiumBps, minTreasury: buyback.minTreasurySol });
      const bytes = compileGraph(g);
      const verdict = verifyGraph(bytes);
      if (!verdict.ok) throw new Error(verdict.message);
      graph = {
        template: "daily-buyback-burn",
        bytes,
        hash: graphHash(bytes),
        explanation: explainGraph(g),
        publishVia: bytes.length <= PUBLISH_GRAPH_LEGACY_MAX_BYTES ? "legacy" : "v1",
      };
    } catch (e) {
      errors.push(`buyback: ${(e as Error).message}`);
    }
  }

  // The window, when the app already knows when the launch opens.
  if (input.opensAt !== undefined) errors.push(...windowErrors(input.opensAt, input.windowSecs, input.nowSecs));

  if (errors.length > 0 || params === null || pdas === null || metadata === null || (toTreasury && graph === null)) {
    throw new Error(`invalid quick launch:\n${errors.join("\n")}`);
  }

  const launchInput: Omit<PlanLaunchInput, "opensAt"> = {
    creator: input.creator,
    identity: Uint8Array.from(pqIdentity),
    params: fairWithFee(feeBps),
    recipients: recipients.map((r) => ({ wallet: r.wallet, bps: r.bps })),
    metadata,
    launchSeed: Uint8Array.from(launchSeed),
    ...(input.windowSecs === undefined ? {} : { windowSecs: input.windowSecs }),
  };
  let plan: LaunchPlan | null = null;
  if (input.opensAt !== undefined) {
    try {
      plan = planLaunch({ ...launchInput, opensAt: input.opensAt, nowSecs: input.nowSecs });
    } catch (e) {
      throw new Error(`invalid quick launch:\n${(e as Error).message.replace(/^invalid launch plan:\n/, "")}`);
    }
    if (!plan.launch.equals(pdas.launch)) throw new Error("the launch plan derived another launch address");
    warnings.push(...plan.warnings);
  }
  if (treasury !== null) {
    warnings.push("Fees paid to the treasury wait there until the autopilot's plan is switched on with your quantum-safe key: do those steps before the launch.");
  }

  const fees = feeSummary(params);
  const metadataHash = metadataHashV2(metadata);
  return {
    launch: pdas.launch,
    launchSeed,
    creator: input.creator,
    params,
    recipients,
    treasury,
    metadata,
    metadataHash,
    launchInput,
    plan,
    graph,
    steps: quickSteps(walletBps!, graph),
    summary: quickSummary({ name: input.name, symbol: input.symbol, feeBps, maxFee: fees === null ? null : fees.floorFeeNumerator + fees.maxDynamicFeeNumerator, walletBps: walletBps!, params, buyback: graph === null ? null : buyback }),
    warnings,
  };
}

// --------------------------------------------------------------- summary ---

function quickSummary(o: {
  name: string;
  symbol: string;
  feeBps: number;
  maxFee: bigint | null;
  walletBps: number;
  params: LaunchParams;
  buyback: QuickBuybackSettings | null;
}): string[] {
  const p = o.params;
  const lines: string[] = [];
  lines.push(`${o.name} (${o.symbol}) launches with the Fair settings.`);
  const busy = o.maxFee === null ? "" : ` It can rise to at most ${pctOfNumerator(o.maxFee)} while trading is very busy.`;
  lines.push(`Trading fee: ${pct(o.feeBps)} on every buy and sell.${busy}`);
  const autopilot = "your token's autopilot treasury, which can only use it to buy your token back and burn it";
  if (o.walletBps === BPS) lines.push("Your share of the trading fees is paid to your wallet.");
  else if (o.walletBps === 0) lines.push(`Your share of the trading fees goes to ${autopilot}.`);
  else lines.push(`Your share of the trading fees is split: ${pct(o.walletBps)} to your wallet and ${pct(BPS - o.walletBps)} to ${autopilot}.`);
  lines.push("Anyone can pay out the fees at any time, and they always go where you chose here.");
  lines.push(
    `Your token graduates once buyers have put ${solText(p.migrationQuoteThreshold)} into it: it then moves to a permanent trading pool whose liquidity nobody can ever take out.`,
  );
  if (o.buyback !== null) {
    const b = o.buyback;
    const when = b.minTreasurySol > 0 ? `, as long as the treasury holds at least ${solText(toLamports(b.minTreasurySol))}` : "";
    lines.push(`The autopilot: once a day after your token graduates, it buys back up to ${solText(toLamports(b.solPerBuyback))} of your token and burns it (destroys it for good)${when}.`);
    lines.push(`It never pays more than ${pct(b.premiumBps)} above the token's recent low price, so it can't be pushed into overpaying.`);
    lines.push("Until your token graduates, the fees simply build up in the treasury.");
    lines.push("The autopilot can never sell your token. It can't touch the pool's locked liquidity, create new tokens or freeze anyone's tokens.");
    lines.push(`Changing what the autopilot does needs your quantum-safe key and a public ${AUTOPILOT.UPDATE_TIMELOCK_SECS / 3_600}-hour wait, so holders always see a change coming.`);
  }
  const cap = p.batchWalletCap > 0n ? ` Each wallet can put in at most ${solText(p.batchWalletCap)}.` : "";
  lines.push(`Fair start: for the first ${formatDurationLong(p.openDelaySecs)}, every buy goes into one shared batch filled at the same price, so bots can't jump the queue.${cap}`);
  const limits = [
    p.maxWalletBps > 0 ? `no wallet can hold more than ${pct(p.maxWalletBps)} of the supply` : null,
    p.maxBuyBps > 0 ? `no single buy can be more than ${pct(p.maxBuyBps)} of it` : null,
  ].filter((x): x is string => x !== null);
  if (limits.length > 0) lines.push(`For the first ${formatDurationLong(p.guardSecs)} after your token goes live, ${limits.join(" and ")}.`);
  lines.push("Your quantum-safe key, not just your wallet, must approve the launch, and the name, symbol, icon and links you approve can never be changed.");
  lines.push("Nobody, not even you, can create more tokens, freeze holders, take out the graduated liquidity, block sales or redirect the fees.");
  return lines;
}

// ----------------------------------------------------------------- steps ---

function quickSteps(walletBps: number, graph: QuickLaunchGraph | null): QuickLaunchStep[] {
  const steps: QuickLaunchStep[] = [
    {
      id: "create-launch",
      title: "Create your launch",
      detail: "Your wallet signs to set up the launch with these settings. Wait until it is final before the next step.",
      signer: "creator-wallet",
      sdk: "buildPlannedCreateLaunchTx",
      when: "first",
    },
    {
      id: "fund-helper",
      title: "Fund a one-time helper account",
      detail: "Your wallet sends a little SOL to a temporary account that pays for saving your token's details and your approvals. What is left comes back to you.",
      signer: "creator-wallet",
      sdk: "buildFundThrowawayPayerTx",
      when: "after your launch is created and final",
    },
    {
      id: "save-token-details",
      title: "Save your token's details",
      detail: "The name, symbol, description, icon and links are saved publicly, exactly as you will approve them.",
      signer: "throwaway-payer",
      sdk: "buildPlannedPublishTx + sendPublishMetadataTx + waitForTokenMeta",
      when: "after the helper account is funded",
    },
    {
      id: "approve-launch",
      title: "Approve the launch with your quantum-safe key",
      detail: "Your quantum-safe key signs the settings, your token's details and the launch time. Without this approval the token can never go live.",
      signer: "pq-identity",
      sdk: "buildPlannedAttestTx + sendAttestLaunchTx",
      when: "after your token's details are saved and final, before the launch window",
    },
  ];
  if (graph !== null) {
    steps.push(
      {
        id: "set-up-autopilot",
        title: "Set up the autopilot",
        detail: "Creates your token's autopilot and its treasury, which receives the trading fees you send it.",
        signer: "anyone",
        sdk: "buildInitAutopilotTx",
        when: "any time after your launch is created",
      },
      {
        id: "save-autopilot-plan",
        title: "Save the autopilot's plan",
        detail: "The daily buyback-and-burn plan is saved publicly, so anyone can check exactly what the autopilot will do.",
        signer: graph.publishVia === "legacy" ? "anyone" : "throwaway-payer",
        sdk: graph.publishVia === "legacy" ? "buildPublishGraphTx" : "buildPublishGraphV1Tx",
        when: "after the autopilot is set up",
      },
      {
        id: "approve-autopilot-plan",
        title: "Approve the autopilot's plan with your quantum-safe key",
        detail: `Your quantum-safe key signs to switch this plan on. As the first plan, it can start right away; any later change needs a public ${AUTOPILOT.UPDATE_TIMELOCK_SECS / 3_600}-hour wait.`,
        signer: "pq-identity",
        sdk: "buildPqAuthorizeTx + sendPqAuthorizeTx",
        when: "after the plan is saved",
      },
      {
        id: "switch-on-autopilot",
        title: "Switch the autopilot's plan on",
        detail: "Hands your approval to the autopilot, which lines the plan up to start now.",
        signer: "anyone",
        sdk: "buildActivateTx",
        when: "right after your approval is saved",
      },
      {
        id: "start-autopilot-plan",
        title: "Start the autopilot's plan",
        detail: "Makes the lined-up plan the one the autopilot follows.",
        signer: "anyone",
        sdk: "buildApplyPendingTx",
        when: "right after switching it on (the first plan has no waiting time)",
      },
    );
  }
  steps.push(
    {
      id: "return-helper-sol",
      title: "Get the helper account's leftover SOL back",
      detail: "Whatever SOL the helper account did not spend goes back to your wallet.",
      signer: "throwaway-payer",
      sdk: "buildSweepPayerTx",
      when: graph === null ? "after your launch approval is saved" : "after your approvals are saved",
    },
    {
      id: "go-live",
      title: "Go live",
      detail: "When the launch window opens, anyone can make the token go live; the first to do it wins. The app does it for you right at the opening time.",
      signer: "anyone",
      sdk: "waitForLaunchWindow + buildPlannedLaunchTx",
      when: "when the launch window opens",
    },
  );
  if (graph !== null) {
    steps.push({
      id: "connect-autopilot-token",
      title: "Connect the autopilot to your token",
      detail: "Links the autopilot to your new token so it can burn what it buys back.",
      signer: "anyone",
      sdk: "buildBindMintTx",
      when: "after your token goes live",
    });
  }
  const payTo = walletBps === BPS ? "your wallet" : walletBps === 0 ? "the autopilot's treasury" : `your wallet (${pct(walletBps)}) and the autopilot's treasury (${pct(BPS - walletBps)})`;
  steps.push({
    id: "pay-out-fees",
    title: "Pay out the trading fees",
    detail: `Collects the trading fees and pays your share to ${payTo}. Anyone can do this, at any time.`,
    signer: "anyone",
    sdk: "buildClaimFeesTx (buildClaimLpFeesTx after graduation) + buildDistributeTx",
    when: "after your token goes live, whenever fees have built up",
  });
  if (graph !== null) {
    steps.push(
      {
        id: "connect-autopilot-pool",
        title: "Connect the autopilot to the trading pool",
        detail: "Once your token moves to its permanent trading pool, this links the autopilot to it so buybacks can start.",
        signer: "anyone",
        sdk: "buildBindPoolTx",
        when: "after your token graduates",
      },
      {
        id: "daily-buyback",
        title: "Run the daily buyback",
        detail: "Once a day, a helper checks the price, waits a minute, then runs the buyback and burn. Anyone can run it and earns a small tip from the treasury for doing so.",
        signer: "anyone",
        sdk: "planKeeperStep / runKeeper",
        when: "every day after your token graduates",
      },
    );
  }
  return steps;
}

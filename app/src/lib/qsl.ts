/**
 * QSL-1 (docs/standard/QSL-1.md) in the app: the verdict a verifier returns (§7.1, §7.9) as the app shows it, and the
 * badge wording of Appendix A. Pure functions only.
 *
 * Two sources fill the same `QslVerdict`:
 *   - `qslFromReport`: the verification report `verifyLaunch` already builds (live SDK or the simulated chain), mapped
 *     onto the standard's conditions (§6.2 L1, §6.3 L2). The demo uses it; so did the live app before SDK 0.5.0.
 *   - the SDK's `checkQsl1` (SDK 0.5.0), which implements §7 itself: `lib/backend/live.ts` converts its result.
 *
 * Rules kept here, whatever the source (§6.1, §7.9, Appendix A):
 *   - a level is awarded only on mainnet-beta and only once Noised's programs are final (C1.24); until then a token
 *     that passes everything else is a "candidate" and gets no level;
 *   - there are two levels, No-rug and Quantum-attested (QSL-1 revision 0.4). "Programmable" is NOT a level: when the
 *     creator added launch rules or automation, a descriptive tag sits next to the level ("QSL-1 L2 · programmable —
 *     read its rules") with the SDK's plain-English warnings. It never raises, lowers or colours the level, and is
 *     never called safer;
 *   - every word a badge shows comes from Appendix A, in plain English; the forbidden claims of A.3 never appear.
 */
import type { PublicKey } from "@solana/web3.js";

import type { CheckStatus, TrustedParty, VerificationCheck, VerificationReport } from "./noised";

/** 0 = no level (not QSL-1, or a candidate); 1 = No-rug; 2 = Quantum-attested. There is no level 3. */
export type QslLevel = 0 | 1 | 2;
/** Level 1 and 2 in plain words (Appendix A). */
export const LEVEL_NAMES = { 1: "No-rug", 2: "Quantum-attested" } as const;
export type QslLevelName = (typeof LEVEL_NAMES)[1 | 2];

/** One condition (or one plain group of conditions) of a level. */
export interface QslCheck {
  /** "C1.5" from the SDK, or a plain group id ("supply") when mapped from a verification report. */
  id: string;
  level: 1 | 2;
  /** Holds now (a SHOULD that only warns, or a condition that does not apply yet, holds). */
  ok: boolean;
  /** The SDK's outcome when it gave one ("warn": a SHOULD that does not hold; "skip": does not apply now). */
  status?: "pass" | "fail" | "warn" | "skip";
  /** What a reader sees: a short plain sentence, true when `ok` ("Nobody can mint more"). */
  plain: string;
  /** Technical detail for the full report (may be empty). */
  detail: string;
}

export interface QslVerdict {
  standard: "QSL-1";
  mint: PublicKey;
  /** The awarded level; 0 = none (not QSL-1, or a candidate). */
  level: QslLevel;
  /** Every condition of `wouldBe` holds except program finality or the cluster (§7.9 step 26). */
  candidate: boolean;
  /** The level the token reaches apart from finality and the cluster. */
  wouldBe: QslLevel;
  checks: QslCheck[];
  /** Why the next level is not reached, in plain words. */
  reasons: string[];
  /** Who you still trust (§8.2): shown wherever a level is (§6.1 rule 6). */
  trusted: TrustedParty[];
  /** Noised launched it (a certificate exists). */
  certified: boolean;
  /** Its token details point to a link the creator chose (record uri mode 2): Appendix A's extra line. */
  externalLink: boolean;
  /** The cluster the result was computed on. */
  cluster: string;
  source: "sdk" | "report";
  /** The SDK's own badge words (`qslBadge`, Appendix A), when the SDK computed the verdict. */
  words?: QslWords;
  /**
   * The creator's launch rules and automation, as a description next to the level ("programmable"), with what a
   * holder should be warned about. Null when the token has neither. Never part of the level.
   */
  programmable: QslProgrammableView | null;
}

/** One warning about the token's rules or automation (the SDK's `QslWarning`), most serious first. */
export interface QslProgrammableWarning {
  /** "insiderBuying", "buysBlocked", "transferLimits", "longRule", "operator", "notFrozen", ... */
  kind: string;
  component: "rules" | "autopilot";
  plain: string;
}

/** One check of the programmable component (`P.R1`..`P.R4` rules, `P.G1`..`P.G5` automation): reported, never a level. */
export interface QslProgrammableCheck {
  id: string;
  component: "rules" | "autopilot";
  title: string;
  status: "pass" | "fail" | "skip";
  ok: boolean;
  plain: string;
  detail: string;
}

/**
 * The "programmable" tag and what "read its rules" opens: a description of what the creator added, never a level and
 * never a safety claim (QSL-1 revision 0.4, Appendix A.2).
 */
export interface QslProgrammableView {
  /** "QSL-1 L2 · programmable" (or "QSL-1 L1 · programmable") next to a level; "programmable" next to anything else. */
  text: string;
  /** The words of the link to the rules and automation. */
  link: "read its rules";
  /** One plain sentence: what the creator added, and that it is not a safety feature. */
  summary: string;
  /** The launch rules in plain English (empty: no launch rules). */
  rules: string[];
  /** The automation (Autopilot) in plain English (empty: none running). */
  automation: string[];
  hasRules: boolean;
  hasAutomation: boolean;
  /** What a holder should know, most serious first. */
  warnings: QslProgrammableWarning[];
  /** "caution" with any warning, "neutral" otherwise: never a positive (green) tone. */
  tone: "caution" | "neutral";
  /** Every present component's checks pass. */
  verified: boolean;
  checks: QslProgrammableCheck[];
}

/** `QslResult.programmable` as the app reads it (structural: the SDK's `QslProgrammable`, SDK 0.8.0). */
export interface SdkQslProgrammable {
  readonly present: boolean;
  readonly verified: boolean;
  readonly rules?: { readonly explain: readonly string[] } | null | undefined;
  readonly autopilot?: { readonly explain: readonly string[] } | null | undefined;
  readonly checks: readonly QslProgrammableCheck[];
  readonly warnings: readonly { readonly kind: string; readonly component: "rules" | "autopilot"; readonly plain: string }[];
}

/** `QslBadge.programmable` as the app reads it (structural: the SDK's `QslBadgeProgrammable`). */
export interface SdkQslBadgeProgrammable {
  readonly text: string;
  readonly link: string;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly tone: "caution" | "neutral";
}

/** Appendix A.2, the programmable tag's sentence (the SDK's `qslBadge` words, kept identical: test/qsl.test.ts). */
export const PROGRAMMABLE_SUMMARY = {
  both: "Its creator added launch rules and automation. They are not a safety feature: read its rules.",
  rules: "Its creator added launch rules that limit some transfers for a while. They are not a safety feature: read its rules.",
  autopilot: "Its creator set up automation that runs on its treasury. It is not a safety feature: read its rules.",
} as const;

/** The badge label a level's tag is attached to ("QSL-1 L2"), or null without a level. */
const levelLabelOf = (level: QslLevel): string | null => (level === 2 ? "QSL-1 L2" : level === 1 ? "QSL-1 L1" : null);

/**
 * The programmable tag for a verdict at `level` (null when the creator added neither rules nor automation). `tag` is
 * the SDK's own badge words when the SDK computed the verdict; they win.
 */
export function programmableView(p: SdkQslProgrammable | null | undefined, level: QslLevel, tag: SdkQslBadgeProgrammable | null = null): QslProgrammableView | null {
  if (p === null || p === undefined || !p.present) return null;
  const rules = p.rules !== null && p.rules !== undefined;
  const automation = p.autopilot !== null && p.autopilot !== undefined;
  const label = levelLabelOf(level);
  const warnings = p.warnings.map((w) => ({ kind: w.kind, component: w.component, plain: w.plain }));
  return {
    text: tag?.text ?? (label === null ? "programmable" : `${label} · programmable`),
    link: "read its rules",
    summary: tag?.summary ?? (rules && automation ? PROGRAMMABLE_SUMMARY.both : automation ? PROGRAMMABLE_SUMMARY.autopilot : PROGRAMMABLE_SUMMARY.rules),
    rules: [...(p.rules?.explain ?? [])],
    automation: [...(p.autopilot?.explain ?? [])],
    hasRules: rules,
    hasAutomation: automation,
    warnings,
    tone: warnings.length > 0 ? "caution" : "neutral",
    verified: p.verified,
    checks: p.checks.map((c) => ({ ...c })),
  };
}

/** What the SDK's `qslBadge` says for a result: the badge, its line, what else may be said, what must be said. */
export interface QslWords {
  title: string;
  summary: string;
  also: string[];
  required: string[];
  /** Appendix A.1: whether a list or trade screen may show it (a candidate only off mainnet). */
  showOnCards: boolean;
}

// ------------------------------------------------------- from the SDK (0.5.0) ---

/** `checkQsl1`'s result as the app reads it (structural: the SDK's `QslResult`). */
export interface SdkQslResult {
  readonly standard: "QSL-1";
  readonly mint: PublicKey;
  readonly cluster: string;
  readonly level: QslLevel;
  readonly candidate: boolean;
  readonly wouldBe: QslLevel;
  readonly checks: readonly { readonly id: string; readonly level: 1 | 2; readonly status: "pass" | "fail" | "warn" | "skip"; readonly ok: boolean; readonly plain: string; readonly detail: string }[];
  readonly reasons: readonly string[];
  readonly trusted: readonly TrustedParty[];
  readonly uriMode: number | null;
  /** SDK 0.8.0: the creator's launch rules and automation (a description, never a level). */
  readonly programmable?: SdkQslProgrammable | undefined;
}

/** `qslBadge`'s result as the app reads it (structural: the SDK's `QslBadge`). */
export interface SdkQslBadge {
  readonly title: string;
  readonly summary: string;
  readonly lines: readonly string[];
  readonly required: readonly string[];
  readonly showOnTradeScreen: boolean;
  /** SDK 0.8.0: the "programmable" tag (null: no rules or automation). */
  readonly programmable?: SdkQslBadgeProgrammable | null | undefined;
}

/**
 * The SDK's verdict (`checkQsl1`, which implements §7 itself) and its badge words (`qslBadge`) as the app shows them.
 * The level, candidate state and reasons are the SDK's, unchanged.
 */
export function qslFromSdk(r: SdkQslResult, badge: SdkQslBadge | null): QslVerdict {
  const checks: QslCheck[] = r.checks.map((c) => ({ id: c.id, level: c.level, ok: c.ok, status: c.status, plain: c.plain, detail: c.detail }));
  const programmable = programmableView(r.programmable, r.level, badge?.programmable ?? null);
  // The tag's sentence and warnings are shown with the tag, not again among "what this means for you".
  const tagLines = new Set(programmable === null ? [] : [programmable.summary, ...programmable.warnings.map((w) => w.plain), ...(badge?.programmable?.warnings ?? [])]);
  const words: QslWords | undefined =
    badge === null
      ? undefined
      : {
          title: badge.title,
          summary: badge.summary,
          also: badge.lines.filter((l) => l !== badge.summary && !badge.required.includes(l) && !tagLines.has(l)),
          required: [...badge.required],
          showOnCards: badge.showOnTradeScreen,
        };
  return {
    standard: "QSL-1",
    mint: r.mint,
    level: r.level,
    candidate: r.candidate,
    wouldBe: r.wouldBe,
    checks,
    reasons: [...r.reasons],
    trusted: [...r.trusted],
    certified: r.checks.some((c) => c.id === "C1.1" && c.ok),
    externalLink: r.uriMode === 2,
    cluster: r.cluster,
    source: "sdk",
    ...(words === undefined ? {} : { words }),
    programmable,
  };
}

// ------------------------------------------------- from a verification report ---

interface Group {
  id: string;
  level: 1 | 2;
  plain: string;
  /** Said when the group does not hold. */
  missing: string;
  ids: readonly string[];
  /** A warning counts as a failure (program finality: "still upgradeable" is a warning in the report). */
  strict?: boolean;
}

/**
 * The standard's conditions as plain groups, with the verification report's check ids that establish them (the SDK's
 * ids and the simulated chain's). §6.2 C1.1 to C1.24 and §6.3 C2.1 to C2.8.
 */
const GROUPS: readonly Group[] = [
  {
    id: "certificate",
    level: 1,
    plain: "Launched by Noised: its certificate is on-chain and matches",
    missing: "No matching Noised certificate",
    ids: ["certificate.exists", "certificate.account", "certificate.launch", "certificate.params", "certificate.checks", "launch.account"],
  },
  { id: "supply", level: 1, plain: "Nobody can mint more", missing: "More tokens could be minted", ids: ["mint.mintAuthority", "mint.supply", "certificate.bit1"] },
  { id: "freeze", level: 1, plain: "Nobody can freeze your tokens", missing: "Tokens could be frozen", ids: ["mint.freezeAuthority", "certificate.bit2"] },
  {
    id: "details",
    level: 1,
    plain: "Its name, symbol and icon can never change",
    missing: "Its name or details could change",
    ids: ["mint.metadata", "mint.metadataPointer", "certificate.bit4", "certificate.bit8"],
  },
  { id: "features", level: 1, plain: "No hidden token features like fees or pauses", missing: "It has a token feature QSL-1 does not allow", ids: ["mint.extensions", "mint.program", "certificate.bit16"] },
  {
    id: "selling",
    level: 1,
    plain: "Selling is never blocked by the launch guard, and its limits end within 72 hours",
    missing: "The launch guard is not the one QSL-1 requires",
    ids: ["mint.transferHook", "hook.policy", "hook.metaList", "certificate.bit32"],
  },
  {
    id: "liquidity",
    level: 1,
    plain: "All liquidity is locked forever once it graduates",
    missing: "Its liquidity is not locked for good",
    ids: ["dbc.lpLocked", "dbc.noMigrationFee", "damm.lpLocked", "damm.lock", "damm.pool", "certificate.bit64", "certificate.bit128"],
  },
  { id: "allocation", level: 1, plain: "No team allocation", missing: "Someone kept an allocation", ids: ["dbc.noCreatorAllocation", "certificate.bit256"] },
  {
    id: "fees",
    level: 1,
    plain: "Fees go only to the wallets listed at launch, at most 10% a trade",
    missing: "Its fees or pool are not the ones QSL-1 requires",
    ids: ["fees.routing", "dbc.config", "dbc.fees", "dbc.pool", "dbc.quoteWsol", "certificate.bit512"],
  },
  {
    id: "final",
    level: 1,
    plain: "Noised's programs can no longer be changed",
    missing: "Noised's programs can still be upgraded",
    ids: ["program.launchpad", "program.hook"],
    strict: true,
  },
  {
    id: "signature",
    level: 2,
    plain: "Its creator's quantum-resistant signature checks out",
    missing: "No valid quantum-resistant signature from its creator",
    ids: ["pq.origin", "certificate.bit1024"],
  },
  {
    id: "onchain",
    level: 2,
    plain: "Name, symbol, description and icon are stored on-chain and signed",
    missing: "Its details are not the signed on-chain record",
    ids: ["metadata.onchain", "metadata.match", "certificate.bit2048"],
  },
];

const statusOk = (s: CheckStatus, strict: boolean): boolean => s === "pass" || (!strict && s === "warn");

/**
 * The QSL-1 verdict from a verification report (`verifyLaunch`). Fails closed: a group with no check in the report
 * does not hold. `cluster` is the cluster the report was read from (only "mainnet" can award a level). `programmable`:
 * the creator's rules and automation in the SDK's shape (the simulated chain builds it), never part of the level.
 */
export function qslFromReport(report: VerificationReport, cluster: string, programmable: SdkQslProgrammable | null = null): QslVerdict {
  const byId = new Map<string, VerificationCheck>(report.checks.map((c) => [c.id, c]));
  const certified = byId.get("certificate.exists")?.status === "pass";
  const checks: QslCheck[] = GROUPS.map((g) => {
    const found = g.ids.map((id) => byId.get(id)).filter((c): c is VerificationCheck => c !== undefined);
    const strict = g.strict === true;
    const ok = certified && found.length > 0 && found.every((c) => statusOk(c.status, strict));
    // The detail a reader needs: what failed, else what warned, else the first confirmation.
    const bad = found.filter((c) => !statusOk(c.status, strict));
    const warned = found.filter((c) => c.status === "warn");
    const shown = bad.length > 0 ? bad : warned.length > 0 ? warned : found.slice(0, 1);
    const detail =
      found.length > 0
        ? shown.map((c) => c.detail).join(" ")
        : g.id === "final"
          ? "This network does not report whether Noised's programs are final; on a test network they can still be upgraded."
          : "Not reported by the verifier.";
    return { id: g.id, level: g.level, ok, plain: ok ? g.plain : g.missing, detail };
  });
  const externalLink = byId.get("metadata.onchain")?.status === "warn";
  const v = decide({ mint: report.mint, checks, trusted: report.trustedParties, certified, externalLink, cluster, source: "report" });
  return { ...v, programmable: programmableView(programmable, v.level) };
}

/**
 * The level from the checks (§7.9): L1 needs every L1 check, L2 every L1 and L2 check; finality ("final" or C1.24)
 * and the cluster decide between a level and "candidate".
 */
export function decide(v: Pick<QslVerdict, "mint" | "checks" | "trusted" | "certified" | "externalLink" | "cluster" | "source"> & { programmable?: QslProgrammableView | null }): QslVerdict {
  const isFinal = (c: QslCheck): boolean => c.id === "final" || c.id === "C1.24";
  const l1 = v.checks.filter((c) => c.level === 1);
  const l2 = v.checks.filter((c) => c.level === 2);
  const finalOk = l1.some(isFinal) && l1.filter(isFinal).every((c) => c.ok);
  const l1ok = v.certified && l1.length > 0 && l1.filter((c) => !isFinal(c)).every((c) => c.ok);
  const l2ok = l1ok && l2.length > 0 && l2.every((c) => c.ok);
  const wouldBe: QslLevel = l2ok ? 2 : l1ok ? 1 : 0;
  const mainnet = v.cluster === "mainnet" || v.cluster === "mainnet-beta";
  const awarded = wouldBe > 0 && finalOk && mainnet;
  const level: QslLevel = awarded ? wouldBe : 0;
  const candidate = wouldBe > 0 && !awarded;
  const reasons: string[] = [];
  if (!v.certified) reasons.push("Noised did not launch this token, so QSL-1 does not apply to it.");
  else if (wouldBe === 0) reasons.push(...l1.filter((c) => !c.ok && !isFinal(c)).map((c) => `${c.plain}.`));
  else {
    if (!finalOk) reasons.push("Not final yet: Noised's programs can still be upgraded.");
    if (!mainnet) reasons.push("Levels are given only on Solana mainnet; this is a test network.");
    if (wouldBe === 1) reasons.push(...l2.filter((c) => !c.ok).map((c) => `${c.plain}.`));
  }
  return {
    standard: "QSL-1",
    mint: v.mint,
    level,
    candidate,
    wouldBe,
    checks: v.checks,
    reasons,
    trusted: v.trusted,
    certified: v.certified,
    externalLink: v.externalLink,
    cluster: v.cluster,
    source: v.source,
    programmable: v.programmable ?? null,
  };
}

// ------------------------------------------------------------------- badge ---

export type QslTone = "attested" | "norug" | "candidate" | "none";

export interface QslBadgeView {
  /** "QSL-1 · Quantum-attested", "QSL-1 candidate", "Not QSL-1". */
  label: string;
  /** "Quantum-attested", "No-rug", "Candidate", "Not QSL-1": the chip's short text. */
  short: string;
  tone: QslTone;
  /** Levels lit on the badge's pips (candidates light the level they would reach, dimmed). */
  pips: QslLevel;
  /** The badge's one-line description (A.2). */
  line: string;
  /** What else the app may say, as plain bullet points (A.2 "You may also say"). */
  lines: string[];
  /** Required nearby (A.2). */
  required: string[];
  /** The "programmable" tag shown next to the badge (never part of it), or null. */
  programmable: QslProgrammableView | null;
}

const NOT_ADVICE = "This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams.";
const WALLETS = "The token itself sits in normal wallets, which are not quantum-resistant.";
const EXTERNAL = "Its icon link was chosen by the creator; what it shows can change.";
const L1_LINE = "Nobody can mint more, freeze your tokens, change its name or pull its liquidity.";
const L2_LINE = "Launched with its creator's quantum-resistant signature, checked just now.";
const L1_MAY = [
  "Selling is never blocked by the launch guard.",
  "Launch limits end within 72 hours.",
  "Fees go only to the wallets listed at launch.",
  "No team allocation.",
  "All liquidity is locked forever once it graduates.",
];
const L2_MAY = ["Name, symbol, description and icon are stored on-chain and signed.", "No one could have launched it with different details or at a different time."];

/** The two levels in plain words, for the explainer (Appendix A.2's one-line descriptions). */
export const LEVELS: readonly { level: 1 | 2; name: QslLevelName; line: string }[] = [
  { level: 1, name: "No-rug", line: L1_LINE },
  { level: 2, name: "Quantum-attested", line: "Launched with its creator's quantum-resistant signature, checked on-chain." },
];

/** What the "programmable" tag means, for the explainer: a description, not a level, never "safer". */
export const PROGRAMMABLE_MEANS = "Programmable is not a level and not a safety feature: it means its creator added launch rules or automation. Read them before you buy.";

/**
 * The badge for a verdict (Appendix A). `where`: "card" for lists and trade screens, "page" for a token's own page
 * and Verify. On mainnet a candidate shows nothing on cards (A.1); a token that is not QSL-1 shows nothing on cards
 * (A.1: "Not QSL-1" or nothing; the card already says when a check failed). Null: show nothing.
 */
export function qslBadgeView(v: QslVerdict, where: "card" | "page"): QslBadgeView | null {
  const own = ownBadgeView(v, where);
  const w = v.words;
  if (own === null || w === undefined) return own;
  // The SDK computed the verdict: its badge words (Appendix A) and its rule for lists win.
  if (where === "card" && !w.showOnCards) return null;
  return { ...own, label: w.title, line: w.summary, lines: w.also, required: w.required };
}

function ownBadgeView(v: QslVerdict, where: "card" | "page"): QslBadgeView | null {
  const mainnet = v.cluster === "mainnet" || v.cluster === "mainnet-beta";
  const required = (lvl: QslLevel): string[] => [NOT_ADVICE, ...(lvl >= 2 ? [WALLETS] : []), ...(v.externalLink ? [EXTERNAL] : [])];
  const programmable = v.programmable;
  if (v.level === 2) {
    return { label: "QSL-1 · Quantum-attested", short: "Quantum-attested", tone: "attested", pips: 2, line: L2_LINE, lines: [...L1_MAY, ...L2_MAY], required: required(2), programmable };
  }
  if (v.level === 1) {
    return { label: "QSL-1 · No-rug", short: "No-rug", tone: "norug", pips: 1, line: L1_LINE, lines: L1_MAY, required: required(1), programmable };
  }
  if (v.candidate) {
    if (where === "card" && mainnet) return null;
    const name = LEVEL_NAMES[v.wouldBe === 2 ? 2 : 1];
    return {
      label: "QSL-1 candidate",
      short: "Candidate",
      tone: "candidate",
      pips: v.wouldBe,
      line: `Passes every check for ${name}. Not final yet: Noised's programs can still be upgraded${mainnet ? "" : " on this test network"}, so no level is given.`,
      lines: v.wouldBe === 2 ? [...L1_MAY, ...L2_MAY] : L1_MAY,
      required: required(v.wouldBe),
      programmable,
    };
  }
  if (where === "card") return null;
  return {
    label: "Not QSL-1",
    short: "Not QSL-1",
    tone: "none",
    pips: 0,
    line: v.certified ? (v.reasons[0] ?? "It does not meet the standard.") : "Noised did not launch this token, so QSL-1 does not apply to it.",
    lines: [],
    required: [],
    programmable,
  };
}

/** Claims Appendix A.3 forbids, as patterns over any text a badge shows (the tests run every badge through it). */
export const FORBIDDEN_CLAIMS: readonly RegExp[] = [
  /quantum[- ]?proof/i,
  /quantum[- ]?safe token/i,
  /unhackable/i,
  /can'?t lose value/i,
  /safe investment/i,
  /risk[- ]?free/i,
  /verified (project|team)/i,
  /\bofficial\b/i,
  /trusted creator/i,
  /\baudited\b/i,
  /\b(private|anonymous)\b/i,
];

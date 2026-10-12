/**
 * What an app shows for a QSL-1 result (QSL-1 Appendix A, normative for
 * apps): the badge, its one-line description, what it may also say, the
 * lines required next to it, and whether a trade screen may show it. The
 * wording is the standard's; nothing here says "quantum-proof", "verified
 * team", "audited" or anything else Appendix A.3 forbids.
 */
import type { QslLevel, QslResult } from "./check.js";
import { isKnownCertificateVersion, QSL1 } from "./layouts.js";

/** The badge's short label. There is no level 3: "programmable" is a tag next to the level (`programmable`). */
export type QslBadgeLabel = "QSL-1 L1" | "QSL-1 L2" | "QSL-1 candidate" | "Not QSL-1";

/** How to colour it: a level (`positive`), a candidate (`caution`), not QSL-1 (`neutral`). */
export type QslBadgeTone = "positive" | "caution" | "neutral";

/**
 * The "programmable" tag shown next to the badge when the token has launch
 * rules or automation its creator set (QSL-1 revision 0.4, Appendix A.2): a
 * description and a link to read them, with the warnings. It is never a
 * safety level and never shown as one: its tone is never `positive`.
 */
export interface QslBadgeProgrammable {
  readonly tag: "programmable";
  /** "QSL-1 L2 · programmable" (or "QSL-1 L1 · programmable") next to a level; "programmable" otherwise. */
  readonly text: string;
  /** The words of the link to the rules and automation. */
  readonly link: "read its rules";
  /** One plain sentence: what the creator added, and that it is not a safety feature. */
  readonly summary: string;
  /** The rules, then the automation, in plain English (what `read its rules` opens). */
  readonly explain: string[];
  /** The warnings' sentences, most serious first (also in the badge's `lines`). */
  readonly warnings: string[];
  /** `caution` when there is a warning, `neutral` otherwise. */
  readonly tone: "caution" | "neutral";
}

/** `qslBadge`'s result. */
export interface QslBadge {
  readonly label: QslBadgeLabel;
  /** The level's plain name ("No-rug", "Quantum-attested"); for a candidate, the level it would have; null for "Not QSL-1". */
  readonly name: string | null;
  /** The badge text of Appendix A: "QSL-1 · No-rug", "QSL-1 · Quantum-attested", "QSL-1 candidate: not final yet" or "Not QSL-1". */
  readonly title: string;
  readonly tone: QslBadgeTone;
  /** The one-line description. */
  readonly summary: string;
  /** Everything to show near the badge, in order: the summary, the programmable tag's sentence and warnings, what it may also say, then the required lines. */
  readonly lines: string[];
  /** The lines Appendix A requires next to the badge (also at the end of `lines`). */
  readonly required: string[];
  /**
   * Appendix A.1: whether a trade screen may show it. A level and "Not
   * QSL-1": yes. A candidate: only on a cluster known not to be mainnet
   * (`devnet`, `other`); on mainnet, and when the cluster is `unknown` (the
   * RPC may still be mainnet), show nothing on a trade screen (developer
   * views may still show it).
   */
  readonly showOnTradeScreen: boolean;
  /** The mint's address: always show it with the badge, never let the badge replace the name or address (A.1, §8.5). */
  readonly mint: string;
  /** The "programmable" tag (rules or automation present), or null. Never a level, never "safer". */
  readonly programmable: QslBadgeProgrammable | null;
}

/** The plain names of the levels (Appendix A.2). */
export const QSL1_LEVEL_NAMES: Readonly<Record<1 | 2, string>> = { 1: "No-rug", 2: "Quantum-attested" };

const L1_SUMMARY = "Nobody can mint more, freeze your tokens, change its name or pull its liquidity.";
const L1_ALSO = [
  "Selling is never blocked by the launch guard.",
  "Launch limits end within 72 hours.",
  "Fees go only to the wallets listed at launch.",
  "No team allocation.",
  "All liquidity is locked forever once it graduates.",
];
const L1_REQUIRED = ["This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams."];
const L2_SUMMARY = "Launched with its creator's quantum-resistant signature, checked just now.";
const L2_ALSO = ["Name, symbol, description and icon are stored on-chain and signed.", "No one could have launched it with different details or at a different time."];
const L2_REQUIRED = ["The token itself sits in normal wallets, which are not quantum-resistant."];
const EXTERNAL_LINK = "Its icon link was chosen by the creator; what it shows can change.";
/** Appendix A.2, the programmable tag: what was added, never a safety claim. */
const PROGRAMMABLE_SUMMARY = {
  both: "Its creator added launch rules and automation. They are not a safety feature: read its rules.",
  rules: "Its creator added launch rules that limit some transfers for a while. They are not a safety feature: read its rules.",
  autopilot: "Its creator set up automation that runs on its treasury. It is not a safety feature: read its rules.",
} as const;

/** The programmable tag of a result (null when nothing is present). */
function programmableTag(result: QslResult, levelLabel: string | null): QslBadgeProgrammable | null {
  const p = result.programmable;
  if (p === undefined || p === null || !p.present) return null;
  const rules = p.rules !== undefined && p.rules !== null;
  const autopilot = p.autopilot !== undefined && p.autopilot !== null;
  const summary = rules && autopilot ? PROGRAMMABLE_SUMMARY.both : autopilot ? PROGRAMMABLE_SUMMARY.autopilot : PROGRAMMABLE_SUMMARY.rules;
  const warnings = p.warnings.map((w) => w.plain);
  return {
    tag: "programmable",
    text: levelLabel === null ? "programmable" : `${levelLabel} · programmable`,
    link: "read its rules",
    summary,
    explain: [...(p.rules?.explain ?? []), ...(p.autopilot?.explain ?? [])],
    warnings,
    tone: warnings.length > 0 ? "caution" : "neutral",
  };
}

/**
 * The badge for a `checkQsl1` result (Appendix A): a level is shown with its
 * plain name and the standard's lines; a candidate as "QSL-1 candidate: not
 * final yet" with why (programs still upgradeable, not mainnet, or the
 * network could not be confirmed); anything else as "Not QSL-1", never as a
 * partial badge. A certificate of a version this checker does not know is
 * named as such (§10.2 rule 4), not as a token without Noised's protections.
 *
 * Launch rules or automation add the "programmable" tag (`programmable`:
 * "QSL-1 L2 · programmable", "read its rules"), whose sentence and warnings
 * come right after the summary in `lines`. The tag never changes the label,
 * the name, the title or the tone: programmable is not safer.
 */
export function qslBadge(result: QslResult): QslBadge {
  if (result === null || typeof result !== "object" || result.standard !== "QSL-1") throw new TypeError("result must be a checkQsl1 result");
  const mint = result.mint.toBase58();
  const level: QslLevel = result.level;
  if (level === 1 || level === 2) {
    const label = level === 2 ? "QSL-1 L2" : "QSL-1 L1";
    const programmable = programmableTag(result, label);
    const tagLines = programmable === null ? [] : [programmable.summary, ...programmable.warnings];
    const external = result.uriMode === 2 ? [EXTERNAL_LINK] : [];
    const summary = level === 2 ? L2_SUMMARY : L1_SUMMARY;
    const also = level === 2 ? [L1_SUMMARY, ...L1_ALSO, ...L2_ALSO, ...external] : [...L1_ALSO, ...external];
    const required = level === 2 ? [...L1_REQUIRED, ...L2_REQUIRED] : [...L1_REQUIRED];
    return {
      label,
      name: QSL1_LEVEL_NAMES[level],
      title: `QSL-1 · ${QSL1_LEVEL_NAMES[level]}`,
      tone: "positive",
      summary,
      lines: [summary, ...tagLines, ...also, ...required],
      required,
      showOnTradeScreen: true,
      mint,
      programmable,
    };
  }
  const programmable = programmableTag(result, null);
  const tagLines = programmable === null ? [] : [programmable.summary, ...programmable.warnings];
  const wouldBe = result.wouldBe as number;
  if (result.candidate && (wouldBe === 1 || wouldBe === 2)) {
    const name = QSL1_LEVEL_NAMES[wouldBe];
    const summary = `Meets every check for Level ${wouldBe} (${name}), but no level is given yet.`;
    const why: string[] = [];
    if (result.blocking.includes("C1.24")) why.push("Noised's programs can still be updated by their team; levels are given only once they are final.");
    if (result.blocking.includes("cluster")) {
      why.push(
        result.cluster === "devnet"
          ? "This is Solana devnet, a test network; levels are given only on mainnet."
          : result.cluster === "other"
            ? "This is not Solana mainnet; levels are given only on mainnet."
            : "The network could not be confirmed as Solana mainnet; levels are given only on mainnet.",
      );
    }
    const required = [...L1_REQUIRED];
    return {
      label: "QSL-1 candidate",
      name,
      title: "QSL-1 candidate: not final yet",
      tone: "caution",
      summary,
      lines: [summary, ...why, ...tagLines, ...required],
      required,
      // A.1: only on a cluster known not to be mainnet; `unknown` may still be mainnet.
      showOnTradeScreen: result.cluster === "devnet" || result.cluster === "other",
      mint,
      programmable,
    };
  }
  // §10.2 rule 4: a certificate of a version this checker does not know is named, never "no certificate".
  const version = result.certificateVersion ?? null;
  if (version !== null && !isKnownCertificateVersion(version) && (result.blocking.includes("C1.1") || result.blocking.includes("C1.2"))) {
    const newer = version > QSL1.CERTIFICATE.VERSION;
    const summary = newer ? `This token's launch certificate is version ${version}, newer than this checker knows.` : `This token's launch certificate is version ${version}, which this checker does not know.`;
    const next = newer ? "An updated checker is needed to tell whether it meets QSL-1." : "No QSL-1 level can be given for it.";
    return { label: "Not QSL-1", name: null, title: "Not QSL-1", tone: "neutral", summary, lines: [summary, next], required: [], showOnTradeScreen: true, mint, programmable: null };
  }
  const noCertificate = result.blocking.includes("C1.1");
  const summary = noCertificate ? "This token was not launched with Noised's protections." : "This token does not meet the QSL-1 standard.";
  const reasons = noCertificate ? [] : result.reasons.slice(0, 3);
  return { label: "Not QSL-1", name: null, title: "Not QSL-1", tone: "neutral", summary, lines: [summary, ...reasons, ...tagLines], required: [], showOnTradeScreen: true, mint, programmable };
}

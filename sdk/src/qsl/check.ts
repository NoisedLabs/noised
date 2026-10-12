/**
 * QSL-1, the quantum security layer token standard (docs/standard/QSL-1.md):
 * the verification algorithm of its §7, condition by condition.
 *
 * `checkQsl1(conn, mint)` reads the accounts the standard names (§3.3), in
 * its steps (§7.2 to §7.6: one `getMultipleAccounts` for the mint, the
 * certificate, the hook accounts and the programs, one for the launch, the
 * DBC config and pool, the attestation, the identity, the record, the rules
 * record the certificate binds and the launch's autopilot address, after
 * migration the launch authority's token accounts and their DAMM v2
 * positions and pools, and for an autopilot that runs a graph one more for
 * the graph's record, the authorization that activated it (`active_auth`),
 * its last activation and freeze authorizations and the autopilot program;
 * never `getProgramAccounts`, never a URL), at
 * `finalized` commitment by default, each read no older than the one before
 * (`minContextSlot`). `evaluateQsl1(snapshot)` is the pure evaluation of
 * those accounts.
 *
 * The result follows §7.1 (`QslResult`): every condition C1.1 to C1.24 and
 * C2.1 to C2.8 is reported with its status and a plain-English sentence for
 * a badge UI. There are two levels, L1 No-rug and L2 Quantum-attested. A
 * level is awarded only on mainnet-beta (genesis hash) with finalized
 * Noised programs (C1.24); a mint that meets every other condition of a
 * level is a `candidate` (level 0). The certificate's flags are never taken
 * on their own word: every condition is re-checked on live accounts (§6.1
 * rule 2), and a missing, foreign, short or undecodable account fails the
 * condition that reads it (rule 4). Certificates of version 3 (487 bytes)
 * and 4 (519 bytes, with `rules_hash`) are known; one of another version
 * fails C1.1 or C1.2 with that version named (§10.2 rule 4), and the LP
 * position (C1.23) is checked once either `is_migrated` or
 * `migration_progress == 3` says the liquidity moved (§7.6).
 *
 * "Programmable" (QSL-1 revision 0.4 §6.4) is a description, not a level:
 * a token whose certificate binds launch rules, or whose autopilot runs a
 * graph, is reported with `programmable.present`, the rules and the
 * automation in plain English, the component checks (P.R1 to P.R4: the
 * rules bound by the certificate, signed with the attestation, stored as
 * signed and valid, held by the hook; P.G1 to P.G5: the autopilot, its
 * graph, the activation re-verified from account state with its LMS
 * signature (since audit round 4 directly from the autopilot's `active_auth`
 * and `active_activate_at`, no search), the timelock and the freeze, the autopilot program's finality)
 * and the warnings a holder needs (`QslWarning`): buys limited to wallets
 * the creator lists, rules on wallet-to-wallet transfers, rules on for more
 * than an hour, rules that do nothing, automation steps an operator
 * controls, automation that is not frozen (a new plan can take over 72
 * hours after it is approved). Rules and automation never raise a level and
 * a failing component never lowers one: the level is L1 or L2 either way.
 * (SDK 0.7 awarded a "level 3" for them; 0.8 does not.)
 *
 * A dishonest RPC can lie about every account: for decisions of
 * consequence, run it against a second, independent provider and compare.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";

import { bytesEqual, fromHex, isAllZero, toHex } from "../codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, DBC, KNOWN_ACCOUNTS, MIGRATION_FEE_TIERS_BPS, PROGRAM_IDS, SEEDS, TRUST_ANCHORS, WSOL_MINT } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { feeNumeratorToBps, feeScheduleDuration, maxVariableFeeNumerator, minBaseFeeNumerator, withinFeeCeiling } from "../launch/policy.js";
import { decodeTokenMeta, tokenUriBytes, validateTokenMeta, type TokenMetaAccount } from "../metadata/record.js";
import {
  DAMM_POOL_STATUS_ENABLED,
  DBC_MIGRATION_PROGRESS,
  decodeDammPool,
  decodeDammPosition,
  decodeDbcConfigWithTransferHook,
  decodeDbcTransferHookPool,
  type DammPool,
  type DammPosition,
  type DbcConfigWithTransferHook,
  type DbcPoolState,
} from "../meteora/state.js";
import {
  attestationAddress,
  autopilotAddress,
  certificateAddress,
  dammV2PoolAddress,
  dammV2PositionAddress,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  extraAccountMetaListAddress,
  graphRecordAddress,
  hookPolicyAddress,
  identityAddressFromId,
  launchAddress,
  launchPdasFromLaunch,
  launchRulesPda,
  programDataAddress,
  tokenMetaPda,
} from "../pda.js";
import { attestationMessage, authorizationMessage } from "../pq/identity.js";
import { lmsVerify } from "../pq/lms.js";
import { activationPayload, freezePayload } from "../programmable/autopilot/logic.js";
import { verifyGraph } from "../programmable/graph/codec.js";
import { explainGraph } from "../programmable/graph/explain.js";
import { decompileGraph } from "../programmable/graph/model.js";
import { graphHash as hashGraph, rulesHash as hashRules } from "../programmable/hash.js";
import { verifyRules } from "../programmable/rules/codec.js";
import { explainRules } from "../programmable/rules/explain.js";
import { ruleWarnings, type RuleWarningKind } from "../programmable/rules/warnings.js";
import { GENESIS_HASHES } from "../rpc/cluster.js";
import { upgradeableProgramInfo, type UpgradeableProgramInfo } from "../rpc/programs.js";
import { ExtensionType, parseMint, parseTokenAccount, type ParsedMint } from "../token/mint.js";
import type { TrustedParty } from "../types.js";
import { compareDammPoolFee, dammFeePercent } from "../verify/dammFees.js";
import { liveTrustedParties } from "../verify/verifyLaunch.js";
import {
  hasDiscriminator,
  isKnownCertificateVersion,
  leafBitSet,
  QSL1,
  readAttestation,
  readAuthorization,
  readAutopilot,
  readCertificate,
  readGraphRecord,
  readHookPolicy,
  readIdentity,
  readLaunch,
  readLaunchRules,
  type QslAttestation,
  type QslAuthorization,
  type QslAutopilot,
  type QslCertificate,
  type QslIdentity,
  type QslLaunch,
} from "./layouts.js";

// ----------------------------------------------------------------- types ---

/**
 * 0 = not QSL-1; 1 = No-rug; 2 = Quantum-attested. There is no level 3
 * (QSL-1 revision 0.4): "Programmable" is a description (`programmable`).
 */
export type QslLevel = 0 | 1 | 2;
/** A condition's outcome (§7.1). `warn`: a SHOULD condition that does not hold; it does not change the level. */
export type QslStatus = "pass" | "fail" | "warn" | "skip";
/** The cluster the RPC serves, from its genesis hash. Levels exist on mainnet only (§3.1). */
export type QslCluster = "mainnet" | "devnet" | "other" | "unknown";

/** One condition of the standard, as checked. */
export interface QslCheck {
  /**
   * The standard's id: `C1.1` to `C1.24`, `C2.1` to `C2.8`, or `cluster`
   * (§7.1: levels exist on mainnet only).
   */
  readonly id: string;
  /** The level the condition belongs to. */
  readonly level: 1 | 2;
  /** What is checked, in a few plain words (the same whatever the outcome). */
  readonly title: string;
  readonly status: QslStatus;
  /**
   * The condition does not stand in the way of its level: it passed, it is a
   * SHOULD that only warns, or it does not apply now (`skip`, e.g. the LP
   * position before migration). A `skip` that was not checked (the run
   * stopped earlier) is not ok.
   */
  readonly ok: boolean;
  /** One plain-English sentence for the badge UI: what was found. */
  readonly plain: string;
  /** The technical detail (fields, addresses, values) for the full report. */
  readonly detail: string;
}

/**
 * One check of the programmable component (QSL-1 revision 0.4 §6.4): `P.R1`
 * to `P.R4` (launch rules), `P.G1` to `P.G5` (autopilot). Reported, never
 * part of a level. `skip` (ok) when its component is not present.
 */
export interface QslComponentCheck {
  readonly id: string;
  readonly component: "rules" | "autopilot";
  readonly title: string;
  readonly status: "pass" | "fail" | "skip";
  readonly ok: boolean;
  readonly plain: string;
  readonly detail: string;
}

/** What a programmable warning is about. The rules' kinds are `ruleWarnings`' (`RuleWarningKind`). */
export type QslWarningKind = RuleWarningKind | "rulesUnconfirmed" | "operator" | "notFrozen" | "updateQueued" | "autopilotUpgradeable" | "autopilotUnconfirmed";

/** A plain-English warning about the token's rules or automation, for a holder. */
export interface QslWarning {
  readonly kind: QslWarningKind;
  readonly component: "rules" | "autopilot";
  /** One plain-English sentence. */
  readonly plain: string;
  /** The rule it is about (0-based), for rule warnings. */
  readonly rule?: number | undefined;
  /** Seconds after launch the restriction starts and stops, for rule warnings that have them. */
  readonly from?: number | null | undefined;
  readonly to?: number | null | undefined;
  /** `insiderBuying`: the wallets that can still buy; `operator`: the operator (base58). */
  readonly wallets?: readonly string[] | undefined;
}

/**
 * `QslResult.programmable`: the creator's launch rules and automation, as a
 * description shown next to the level ("QSL-1 L2 · programmable: read its
 * rules"). It never raises or lowers the level.
 */
export interface QslProgrammable {
  /** The certificate binds launch rules, or the launch's autopilot runs a graph (`rules` and/or `autopilot` is set). */
  readonly present: boolean;
  /** Every present component's checks pass (P.R1 to P.R4, P.G1 to P.G4); true when nothing is present. */
  readonly verified: boolean;
  /** The launch rules the certificate binds, in plain English; absent when it binds none. */
  readonly rules?: QslRulesView | undefined;
  /** The launch's autopilot running a graph, in plain English; absent when none runs (or its account is not an autopilot's). */
  readonly autopilot?: QslAutopilotView | undefined;
  /** P.R1 to P.R4 and P.G1 to P.G5, in order. */
  readonly checks: readonly QslComponentCheck[];
  /** What a holder should know, most serious first (empty when nothing is present, or nothing needs a warning). */
  readonly warnings: readonly QslWarning[];
}

/** An informational check (§6.6): reported, never part of a level. */
export interface QslInfo {
  readonly id: string;
  readonly title: string;
  readonly status: "pass" | "warn";
  readonly plain: string;
  readonly detail: string;
}

/** `checkQsl1`'s result (QSL-1 §7.1). */
export interface QslResult {
  readonly standard: "QSL-1";
  readonly mint: PublicKey;
  /** The context slot of the reads (the last one; every read is at or after the one before). Null when the RPC gave none. */
  readonly slot: number | null;
  readonly cluster: QslCluster;
  /** The level awarded: 0 unless every condition of it holds on mainnet with finalized programs. */
  readonly level: QslLevel;
  /** Every condition of `wouldBe` holds except program finality (C1.24) and/or the cluster: "QSL-1 candidate: not final yet". */
  readonly candidate: boolean;
  /** The level the mint would have with finalized programs on mainnet. */
  readonly wouldBe: QslLevel;
  /** The creator's launch rules and automation: a description with warnings, never a level (QSL-1 revision 0.4 §6.4). */
  readonly programmable: QslProgrammable;
  /**
   * @deprecated Since 0.8.0 (there is no level 3): use `programmable`. Kept
   * for 0.7 callers: each is true when that component is present and its
   * checks pass (P.R1 to P.R4; P.G1 to P.G4).
   */
  readonly components: { readonly rules: boolean; readonly autopilot: boolean };
  /** The bonding curve completed (C1.19); null when the pool is unreadable. */
  readonly graduated: boolean | null;
  /** The liquidity moved to DAMM v2 (`is_migrated`); null when the pool is unreadable. */
  readonly migrated: boolean | null;
  /** Every condition, in the standard's order (`cluster`, C1.1..C1.24, C2.1..C2.8). */
  readonly checks: QslCheck[];
  /** Why the next level is not reached, in plain English (one line per blocking condition). Empty at level 2. */
  readonly reasons: string[];
  /** The ids of the conditions behind `reasons`. */
  readonly blocking: string[];
  /** §6.6: informational checks (batch caps, first trade, graduated pool, Meteora and Token-2022 code, uri mode, leaves used). */
  readonly info: QslInfo[];
  /** §8.2: who can still change the outcome (with the live upgrade authorities read). */
  readonly trusted: TrustedParty[];
  /** The attested record's uri mode (0 none, 1 inline, 2 external link; null when no record was read). With 2, a badge adds a line. */
  readonly uriMode: number | null;
  /**
   * The version byte of the account at the certificate address, when it is
   * the launchpad's and carries the Certificate discriminator (whatever its
   * length); null otherwise. Versions 3 and 4 are known; any other is one
   * this checker does not know (QSL-1 §10.2 rule 4: C1.1 or C1.2 fails and
   * `qslBadge` names the version). Always set by `checkQsl1` and
   * `evaluateQsl1` (since 0.5.1); optional so results built by hand still
   * type-check (absent = null).
   */
  readonly certificateVersion?: number | null | undefined;
  /** @deprecated Since 0.8.0: `programmable.rules` (null here when absent). */
  readonly rules?: QslRulesView | null | undefined;
  /** @deprecated Since 0.8.0: `programmable.autopilot` (null here when absent). */
  readonly autopilot?: QslAutopilotView | null | undefined;
}

/** `QslProgrammable.rules`: the launch rules a version-4 certificate binds. */
export interface QslRulesView {
  /** `rules_hash` (certificate 487..519) = `SHA256("PHX-RULES-V1" || bytes)`. */
  readonly hash: Uint8Array;
  readonly hashHex: string;
  /** The rules record, `PDA(LAUNCHPAD; "rules", launch, rules_hash)`. */
  readonly address: PublicKey;
  /** The record's PXR1 bytes, when it could be read (null otherwise). */
  readonly bytes: Uint8Array | null;
  /** `explainRules` of the bytes, for the launch's guard: one plain English line per rule, then the guarantees (empty when the bytes do not verify). */
  readonly explain: readonly string[];
  /** P.R1 to P.R4 all pass. */
  readonly verified: boolean;
}

/** `QslProgrammable.autopilot`: the launch's autopilot as read (P.G1 to P.G5). */
export interface QslAutopilotView {
  /** `PDA(AUTOPILOT; "autopilot", launch)`. */
  readonly address: PublicKey;
  /** The running graph's hash (all zero: none) and its PXG1 bytes when its record could be read. */
  readonly activeGraph: Uint8Array;
  readonly activeGraphHex: string;
  readonly graphBytes: Uint8Array | null;
  /** `explainGraph` of the running graph: one plain English line per step, then the guarantees (empty when unreadable). */
  readonly explain: readonly string[];
  /** The running graph can never change again. */
  readonly frozen: boolean;
  /** The running graph's operator (null: none, or revoked). */
  readonly operator: PublicKey | null;
  /** Steps of the running graph only its operator can run (0 when unreadable, or without an operator). */
  readonly operatorSteps: number;
  /** When the running graph took effect (unix seconds). */
  readonly activatedAt: bigint;
  /** The activation time the creator signed for the running graph, when P.G3 found it; null otherwise. */
  readonly activateAt: bigint | null;
  /** The authorization that activated the running graph, when P.G3 bound it to the graph; null otherwise. */
  readonly authorization: PublicKey | null;
  /** The last second the freeze could be used (`not_after`, freeze payload v2), when P.G4 found it; null otherwise. */
  readonly freezeNotAfter: bigint | null;
  /** A queued update: the graph and when it may take effect; null when none is queued. */
  readonly pending: { readonly graphHash: Uint8Array; readonly activateAt: bigint } | null;
  /** The autopilot program can no longer be changed (P.G5). */
  readonly programFinal: boolean;
  /** P.G1 to P.G4 all pass (the program's finality, P.G5, is a warning, not part of this). */
  readonly verified: boolean;
}

/** An account as read (owner and data; `executable` for program accounts). */
export interface QslAccount {
  readonly owner: PublicKey;
  readonly data: Uint8Array;
  readonly executable?: boolean | undefined;
}

/** Everything `evaluateQsl1` looks at. */
export interface QslSnapshot {
  readonly mint: PublicKey;
  /** The RPC's genesis hash (null: could not be read). */
  readonly genesisHash: string | null;
  readonly slot: number | null;
  /** Every account read, by base58 address; null: it does not exist. An address absent from the map counts as missing. */
  readonly accounts: ReadonlyMap<string, QslAccount | null>;
  /** After migration: the Token-2022 token accounts owned by the launch authority (§7.6); null when not read. */
  readonly launchAuthorityTokenAccounts: readonly { readonly address: PublicKey; readonly account: QslAccount }[] | null;
}

/** `evaluateQsl1` options (the autopilot's P.G3 and P.G4). */
export interface EvaluateQsl1Options {
  /**
   * Only for an autopilot account that stores no `active_auth` (audit round
   * 4 added it; the SDK then rebuilds the running graph's approval directly
   * from `active_auth` and `active_activate_at`, without any search): the
   * activation time (unix seconds) the creator signed for the running graph,
   * e.g. `activate_at` of its `GraphQueued` event, tried first; without it
   * P.G3 searches it, one second at a time, from the graph's `activated_at`
   * down to the authorization's `unix_time`. A wrong hint costs one hash and
   * the search runs as without it.
   */
  readonly activateAt?: bigint | number | undefined;
  /**
   * How many candidate seconds that search tries at most (default
   * `QSL1.ACTIVATE_AT_SEARCH_CAP`, 691,200 = 8 days, about 1 s of hashing).
   * Past the cap P.G3 fails, asking for `activateAt`.
   */
  readonly activateAtSearchCap?: number | undefined;
  /**
   * The `not_after` the freeze of a frozen graph was signed with (freeze
   * payload v2), e.g. the `freeze` instruction's argument: tried first. The
   * autopilot does not store it, so without it P.G4 searches it from the
   * freeze authorization's `unix_time` upwards (a freeze is used no earlier
   * than its authorization lands, and never after `not_after`).
   */
  readonly freezeNotAfter?: bigint | number | undefined;
  /** How many candidate seconds that search tries at most (default `QSL1.FREEZE_NOT_AFTER_SEARCH_CAP`, 691,200). */
  readonly freezeNotAfterSearchCap?: number | undefined;
}

/** `checkQsl1` options. */
export interface CheckQsl1Options extends EvaluateQsl1Options {
  /** Commitment of every read (default `finalized`, as §7.1 recommends). */
  readonly commitment?: "finalized" | "confirmed" | undefined;
}

// ------------------------------------------------------------ conditions ---

interface Condition {
  /** The level, or the programmable component a check belongs to. */
  readonly level: 1 | 2 | "rules" | "autopilot";
  readonly title: string;
  readonly pass: string;
  readonly fail: string;
}

/** The conditions' plain-English texts (QSL-1 Appendix A.4: plain words, no jargon). */
const CONDITIONS: Readonly<Record<string, Condition>> = {
  cluster: { level: 1, title: "Checked on Solana mainnet", pass: "Read from Solana mainnet.", fail: "Not read from Solana mainnet: QSL-1 levels are only given on mainnet." },
  "C1.1": { level: 1, title: "Launch certificate", pass: "It has a Noised launch certificate.", fail: "It has no valid Noised launch certificate, so none of these protections apply." },
  "C1.2": {
    level: 1,
    title: "Certificate belongs to this token",
    pass: "The certificate is for this token and follows the current safety rules.",
    fail: "The certificate is not for this token, or follows rules this checker does not know.",
  },
  "C1.3": { level: 1, title: "Every launch check recorded", pass: "All twelve safety checks were recorded when it launched.", fail: "Not every safety check was recorded when it launched." },
  "C1.4": { level: 1, title: "Standard token, supply never grew", pass: "It is a standard Solana token and its supply has never grown.", fail: "The token is not the standard token that was launched, or its supply grew." },
  "C1.5": { level: 1, title: "Nobody can mint more", pass: "Nobody can mint more of this token.", fail: "Someone can still mint more of this token." },
  "C1.6": { level: 1, title: "Nobody can freeze tokens", pass: "Nobody can freeze your tokens.", fail: "Someone can freeze holders' tokens." },
  "C1.7": { level: 1, title: "Name and symbol locked", pass: "Its name, symbol and link can never change.", fail: "Someone can still change its name, symbol or link." },
  "C1.8": { level: 1, title: "Details stored in the token", pass: "Its details are stored in the token itself and cannot be pointed elsewhere.", fail: "Its details can be pointed somewhere else." },
  "C1.9": {
    level: 1,
    title: "No hidden features",
    pass: "No hidden features: no transfer tax, pause, auto-freeze or power to take tokens.",
    fail: "It has extra token features that could tax, pause, freeze or take tokens.",
  },
  "C1.10": { level: 1, title: "Only the launch guard as transfer rule", pass: "The only transfer rule is Noised's launch guard, which never blocks a sale.", fail: "Its transfer rule is not the one a Noised launch has." },
  "C1.11": { level: 1, title: "Fixed trading pool settings", pass: "The trading pool was set up with Noised's fixed safe settings.", fail: "The trading pool's settings are not Noised's safe ones." },
  "C1.12": { level: 1, title: "Liquidity locked forever at graduation", pass: "All of its liquidity gets locked forever when it graduates.", fail: "Not all of its liquidity is set to be locked forever." },
  "C1.13": { level: 1, title: "No cut at graduation", pass: "Nobody takes a cut when it graduates.", fail: "Someone takes a cut when it graduates." },
  "C1.14": { level: 1, title: "No team allocation", pass: "No team allocation: the creator gets no free tokens.", fail: "Tokens are set aside for the creator or team." },
  "C1.15": { level: 1, title: "Trades against SOL", pass: "It trades against SOL.", fail: "It does not trade against SOL." },
  "C1.16": { level: 1, title: "Trading fees capped", pass: "Trading fees are capped at 10%.", fail: "Trading fees could go above 10%." },
  "C1.17": { level: 1, title: "Launch record is live", pass: "Its launch record is live and belongs to Noised.", fail: "Its launch record is missing or not live." },
  "C1.18": { level: 1, title: "Launch record matches", pass: "Its launch record matches the certificate.", fail: "Its launch record does not match the certificate." },
  "C1.19": { level: 1, title: "Its own trading pool", pass: "The trading pool is this launch's own pool.", fail: "The trading pool is not this launch's own pool." },
  "C1.20": {
    level: 1,
    title: "Fees only to wallets set at launch",
    pass: "Fees go only to the 1 to 4 wallets set at launch, and the platform takes at most half.",
    fail: "Fees could go to wallets that were not set at launch.",
  },
  "C1.21": { level: 1, title: "Launch limits match, end within 72 hours", pass: "The launch limits match the certificate and end within 72 hours.", fail: "The launch limits do not match the certificate." },
  "C1.22": { level: 1, title: "Launch guard reads only its own settings", pass: "The launch guard reads only its own settings.", fail: "The launch guard is wired to read something else." },
  "C1.23": { level: 1, title: "Graduated liquidity locked forever", pass: "Its graduated liquidity is locked forever.", fail: "Its graduated liquidity is not locked forever." },
  "C1.24": { level: 1, title: "Noised programs are final", pass: "Noised's programs are final: nobody can change them.", fail: "Noised's programs could not be confirmed final." },
  "C2.1": { level: 2, title: "Signature check recorded", pass: "The launch recorded its creator's quantum-resistant signature check.", fail: "The launch did not record a signature check." },
  "C2.2": { level: 2, title: "Creator's signature stored", pass: "The creator's quantum-resistant signature is stored for this launch.", fail: "No matching creator signature is stored for this launch." },
  "C2.3": { level: 2, title: "Launched inside the signed window", pass: "It went live inside the time window its creator signed.", fail: "It did not go live inside a valid signed time window." },
  "C2.4": {
    level: 2,
    title: "Signature covers these details",
    pass: "The signature covers exactly this launch's settings, creator, details and time window.",
    fail: "The signature does not cover this launch's details.",
  },
  "C2.5": { level: 2, title: "Signed by the named identity", pass: "It was signed by the creator identity the launch names.", fail: "The signing identity is not the one the launch names." },
  "C2.6": { level: 2, title: "Signature checks out", pass: "The quantum-resistant signature checks out (checked just now).", fail: "The quantum-resistant signature does not check out." },
  "C2.7": { level: 2, title: "Details stored on-chain as signed", pass: "Its name, symbol, description and icon are stored on-chain exactly as signed.", fail: "Its stored details are not the ones that were signed." },
  "C2.8": { level: 2, title: "Token shows the signed name", pass: "The token shows exactly the signed name and symbol.", fail: "The token's name or symbol is not the signed one." },
  "P.R1": { level: "rules", title: "Launch rules recorded", pass: "Its launch certificate records the launch rules its creator signed.", fail: "Its launch certificate does not record its launch rules correctly." },
  "P.R2": { level: "rules", title: "Rules signed by the creator", pass: "The creator's quantum-resistant signature covers these launch rules.", fail: "The creator's signature does not cover these launch rules." },
  "P.R3": { level: "rules", title: "Rules stored on-chain and valid", pass: "Its launch rules are stored on-chain exactly as signed, and they are valid.", fail: "Its launch rules are missing, changed or not valid." },
  "P.R4": { level: "rules", title: "Launch guard holds the rules", pass: "The launch guard enforces exactly these rules.", fail: "The launch guard does not hold exactly these rules." },
  "P.G1": { level: "autopilot", title: "Automation set up for this token", pass: "Its automation belongs to this token and a plan is running.", fail: "Its automation is not set up correctly for this token." },
  "P.G2": { level: "autopilot", title: "Automation plan stored and valid", pass: "Its automation plan is stored on-chain and is valid.", fail: "Its automation plan is missing, changed or not valid." },
  "P.G3": { level: "autopilot", title: "Plan switched on by the creator", pass: "The creator's quantum-resistant signature switched on this plan (checked just now).", fail: "The signature that switched on this plan could not be confirmed." },
  "P.G4": { level: "autopilot", title: "Changes wait, freezes are signed", pass: "Changes to its automation wait 72 hours, and only the creator's signature can freeze it.", fail: "Its automation's waiting period or freeze could not be confirmed." },
  "P.G5": { level: "autopilot", title: "Autopilot program is final", pass: "The autopilot program is final: nobody can change it.", fail: "The autopilot program could not be confirmed final." },
};

/** The programmable component's checks (QSL-1 revision 0.4 §6.4): launch rules, then autopilot. Reported, never part of a level. */
const RULES_IDS: readonly string[] = ["P.R1", "P.R2", "P.R3", "P.R4"];
const AUTOPILOT_IDS: readonly string[] = ["P.G1", "P.G2", "P.G3", "P.G4", "P.G5"];
export const QSL1_PROGRAMMABLE_CHECK_IDS: readonly string[] = [...RULES_IDS, ...AUTOPILOT_IDS];

/** Every condition id, in the standard's order (levels 1 and 2). */
export const QSL1_CONDITION_IDS: readonly string[] = ["cluster", ...Array.from({ length: 24 }, (_, i) => `C1.${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `C2.${i + 1}`)];

interface Outcome {
  readonly status: QslStatus;
  readonly detail: string;
  /** Overrides the condition's pass or fail sentence. */
  readonly plain?: string | undefined;
  /** A `skip` because the condition does not apply now (ok), not because it was not checked. */
  readonly notApplicable?: boolean | undefined;
}

const pass = (detail: string, plain?: string): Outcome => ({ status: "pass", detail, plain });
const fail = (detail: string, plain?: string): Outcome => ({ status: "fail", detail, plain });
const verdict = (problems: readonly string[], okDetail: string): Outcome => (problems.length === 0 ? pass(okDetail) : fail(problems.join("; ")));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const b58 = (k: PublicKey | null): string => (k === null ? "None" : k.toBase58());

class Recorder {
  private readonly checks = new Map<string, QslCheck>();
  private readonly parts = new Map<string, QslComponentCheck>();

  set(id: string, o: Outcome): void {
    const c = CONDITIONS[id];
    if (c === undefined) throw new Error(`unknown QSL-1 condition ${id}`);
    const ok = o.status === "pass" || o.status === "warn" || (o.status === "skip" && o.notApplicable === true);
    const plain = o.plain ?? (o.status === "fail" ? c.fail : o.status === "skip" ? "Not checked." : c.pass);
    if (c.level === "rules" || c.level === "autopilot") {
      this.parts.set(id, { id, component: c.level, title: c.title, status: o.status === "warn" ? "pass" : o.status, ok, plain, detail: o.detail });
    } else this.checks.set(id, { id, level: c.level, title: c.title, status: o.status, ok, plain, detail: o.detail });
  }

  /** Run a condition; a throw fails it (fail closed). */
  run(id: string, f: () => Outcome): void {
    let o: Outcome;
    try {
      o = f();
    } catch (e) {
      o = fail(`could not check: ${msg(e)}`);
    }
    this.set(id, o);
  }

  get(id: string): QslCheck | QslComponentCheck | undefined {
    return this.checks.get(id) ?? this.parts.get(id);
  }

  /** Every condition in order; one that was never set is "not checked" (the run stopped before it). */
  list(why: string): QslCheck[] {
    return QSL1_CONDITION_IDS.map((id) => {
      const c = this.checks.get(id);
      if (c !== undefined) return c;
      const d = CONDITIONS[id]!;
      return { id, level: d.level as 1 | 2, title: d.title, status: "skip", ok: false, plain: `Not checked: ${why}`, detail: `not checked: ${why}` };
    });
  }

  /** The programmable component's checks in order; one never set was not reached (the run stopped before it). */
  components(why: string): QslComponentCheck[] {
    return QSL1_PROGRAMMABLE_CHECK_IDS.map((id) => {
      const c = this.parts.get(id);
      if (c !== undefined) return c;
      const d = CONDITIONS[id]!;
      return { id, component: d.level as "rules" | "autopilot", title: d.title, status: "skip", ok: false, plain: `Not checked: ${why}`, detail: `not checked: ${why}` };
    });
  }
}

// ------------------------------------------------------------- evaluate ---

const L = PROGRAM_IDS.launchpad;
const H = PROGRAM_IDS.hook;
const AUTOPILOT = PROGRAM_IDS.autopilot;
const T22 = KNOWN_ACCOUNTS.token2022;
/** The programs read in step 0 (§7.2) and for §6.6. */
const PROGRAMS: readonly PublicKey[] = [L, H, PROGRAM_IDS.dbc, PROGRAM_IDS.dammV2, T22];

function clusterOf(genesisHash: string | null): QslCluster {
  if (genesisHash === null) return "unknown";
  if (genesisHash === QSL1.MAINNET_GENESIS_HASH) return "mainnet";
  if (genesisHash === GENESIS_HASHES.devnet) return "devnet";
  return "other";
}

/**
 * C1.23 is checked (§7.6, the reference behaviour) once either field of the
 * DBC pool says the liquidity moved: `is_migrated != 0` or `migration_progress
 * == 3` (CreatedPool). DBC's migration sets both in one instruction, so they
 * agree on every state it writes; if they ever differ, the LP position is
 * checked rather than skipped. `migrated` in the result stays `is_migrated != 0`.
 */
const lpCheckDue = (pool: DbcPoolState): boolean => pool.isMigrated !== 0 || pool.migrationProgress === DBC_MIGRATION_PROGRESS.CREATED_POOL;

/**
 * C1.3 (§6.5, amendment A2): all twelve bits are set, tested as `(checks &
 * 4095) == 4095` (never `checks == 4095`: a version-4 certificate with rules
 * also carries RULES_BOUND), and no bit this checker does not know is (fail
 * closed): a version-3 certificate holds exactly 4,095; a version-4 one 4,095
 * without rules or 8,191 (RULES_BOUND) exactly when its `rules_hash` is not
 * zero.
 */
function checksOutcome(cert: QslCertificate): Outcome {
  const checks = cert.checks;
  const twelve = checks & QSL1.ALL_CHECKS;
  const extra = checks - twelve; // u32 arithmetic on numbers: exact
  const rulesBound = extra === QSL1.RULES_BOUND;
  const hasRules = cert.rulesHash !== null && !isAllZero(cert.rulesHash);
  const p: string[] = [];
  let plain: string | undefined;
  if (twelve !== QSL1.ALL_CHECKS) p.push(`checks = ${checks}: bits ${QSL1.ALL_CHECKS - twelve} of the twelve (4,095) are missing`);
  if (cert.version !== QSL1.CERTIFICATE.VERSION) {
    if (extra !== 0) {
      p.push(`checks = ${checks} holds bits beyond the twelve (${extra}), which a version-${cert.version} certificate never does`);
      plain = "Its launch certificate records checks this checker does not know.";
    }
  } else {
    if (extra !== 0 && !rulesBound) {
      p.push(`checks = ${checks} holds bits this checker does not know (${extra})`);
      plain = "Its launch certificate records checks this checker does not know.";
    }
    if (rulesBound && !hasRules) p.push("RULES_BOUND (4,096) is set but rules_hash is zero");
    if (!rulesBound && hasRules) p.push("rules_hash is not zero but RULES_BOUND (4,096) is not set");
  }
  if (p.length > 0) return fail(p.join("; "), twelve === QSL1.ALL_CHECKS ? plain ?? "Its launch certificate's checks do not match its launch rules." : undefined);
  return pass(`checks = ${checks}: (checks & 4,095) = 4,095, all twelve bits${rulesBound ? "; RULES_BOUND (4,096) with a non-zero rules_hash" : hasRules ? "" : "; no rules"}`);
}

/** The programmable component (§6.4, §7.8) as evaluated: what is present, whether its checks pass, and the warnings. */
interface ProgrammableState {
  readonly rulesPresent: boolean;
  /** Present and P.R1 to P.R4 pass. */
  readonly rulesHold: boolean;
  readonly autopilotPresent: boolean;
  /** Present and P.G1 to P.G4 pass (the program's finality, P.G5, is a warning). */
  readonly autopilotHolds: boolean;
  readonly warnings: QslWarning[];
}

/** The autopilot program's name in P.G5's detail (its finality is read as C1.24's). */
const AUTOPILOT_NAME = "Noised Autopilot";

/** Warnings, most serious first (stable within a kind). */
const WARNING_ORDER: Readonly<Record<QslWarningKind, number>> = {
  insiderBuying: 0,
  buysBlocked: 1,
  rulesUnconfirmed: 2,
  autopilotUnconfirmed: 3,
  transferLimits: 4,
  operator: 5,
  updateQueued: 6,
  longRule: 7,
  notFrozen: 8,
  autopilotUpgradeable: 9,
  noOpRule: 10,
  complexRule: 11,
};

/** `logic::newer`: authorizations are ordered by `(slot, address)`. */
function newerMark(a: { slot: bigint; key: PublicKey }, b: { slot: bigint; key: PublicKey }): boolean {
  if (a.slot !== b.slot) return a.slot > b.slot;
  const x = a.key.toBytes();
  const y = b.key.toBytes();
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** C1.1 / C1.2's sentence for a certificate version this checker does not know (§10.2 rule 4): named, never "no certificate". */
const unknownVersionPlain = (version: number): string =>
  version > QSL1.CERTIFICATE.VERSION
    ? `Its launch certificate is version ${version}, newer than this checker knows: an updated checker is needed to check it.`
    : `Its launch certificate is version ${version}, which this checker does not know.`;

/** The certificate length each known version has (§5.1). */
const certificateLenOf = (version: number): number | null => (version === QSL1.CERTIFICATE.VERSION ? QSL1.CERTIFICATE.LEN : version === QSL1.CERTIFICATE.V3_VERSION ? QSL1.CERTIFICATE.V3_LEN : null);

const i64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
};

/** The 189-byte attestation message v2 (`"PHX-ATTEST-V2" || LAUNCHPAD || launch || params_hash || creator || metadata_hash || i64le(not_before) || i64le(not_after)`), signed by launches with a version-3 certificate (§7.7.4). */
function attestationMessageV2(f: { launch: PublicKey; paramsHash: Uint8Array; creator: PublicKey; metadataHash: Uint8Array; notBefore: bigint; notAfter: bigint }): Uint8Array {
  const parts = [new TextEncoder().encode(QSL1.ATTESTATION.V2_MESSAGE_TAG), L.toBytes(), f.launch.toBytes(), f.paramsHash, f.creator.toBytes(), f.metadataHash, i64le(f.notBefore), i64le(f.notAfter)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (out.length !== QSL1.ATTESTATION.V2_MESSAGE_LEN) throw new Error("attestation message v2 length mismatch");
  return out;
}

/** `findActivateAt`'s result. */
export interface ActivateAtSearch {
  /** The activation time the payload hash commits to; null when none in the range searched does. */
  readonly activateAt: bigint | null;
  /** Candidate seconds hashed (the hint included). */
  readonly tried: number;
  /** The range was longer than the cap: its lowest seconds were not tried. */
  readonly truncated: boolean;
}

/**
 * P.G3: the `activate_at` an activation payload hash commits to
 * (`payloadHash == SHA256("PHX-GRAPH-ACT-V1" || autopilot || graph_hash ||
 * i64le(activate_at))`), which the autopilot does not store. The program
 * allows only `authorized_at <= activate_at <= activated_at` (the graph was
 * queued after its authorization landed, at or after that moment, and
 * applied at or after `activate_at`), so this tries `hint` first (when in
 * range), then every second from `activatedAt` down to `authorizedAt`, at
 * most `cap` of them (one SHA-256 compression each after a shared prefix:
 * about 0.9 s for the default 691,200 on a desktop CPU).
 */
export function findActivateAt(
  autopilot: PublicKey,
  graphHash: Uint8Array,
  payloadHash: Uint8Array,
  range: { readonly activatedAt: bigint; readonly authorizedAt: bigint },
  opts: { readonly hint?: bigint | number | undefined; readonly cap?: number | undefined } = {},
): ActivateAtSearch {
  const cap = opts.cap ?? QSL1.ACTIVATE_AT_SEARCH_CAP;
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError("the search cap must be a whole number of seconds, 0 or more");
  if (graphHash.length !== 32 || payloadHash.length !== 32) throw new RangeError("graphHash and payloadHash must be 32 bytes");
  const { activatedAt: hi, authorizedAt: lo } = range;
  let tried = 0;
  if (opts.hint !== undefined) {
    const h = BigInt(opts.hint);
    if (h >= lo && h <= hi) {
      tried++;
      if (bytesEqual(activationPayload(autopilot, graphHash, h), payloadHash)) return { activateAt: h, tried, truncated: false };
    }
  }
  if (hi < lo) return { activateAt: null, tried, truncated: false };
  const span = hi - lo + 1n;
  const n = span > BigInt(cap) ? cap : Number(span);
  const base = sha256.create().update(new TextEncoder().encode("PHX-GRAPH-ACT-V1")).update(autopilot.toBytes()).update(graphHash);
  const tail = new Uint8Array(8);
  const view = new DataView(tail.buffer);
  const p0 = payloadHash[0]!;
  const p1 = payloadHash[1]!;
  // Unix times are small non-negative integers: write them as two u32 halves (no bigint per candidate).
  const small = hi <= BigInt(Number.MAX_SAFE_INTEGER) && hi - BigInt(n) >= -1n;
  const hiN = Number(hi);
  for (let i = 0; i < n; i++) {
    if (small) {
      const t = hiN - i;
      view.setUint32(0, t % 0x1_0000_0000, true);
      view.setUint32(4, Math.floor(t / 0x1_0000_0000), true);
    } else view.setBigInt64(0, hi - BigInt(i), true);
    const d = base.clone().update(tail).digest();
    tried++;
    if (d[0] === p0 && d[1] === p1 && bytesEqual(d, payloadHash)) return { activateAt: hi - BigInt(i), tried, truncated: false };
  }
  return { activateAt: null, tried, truncated: span > BigInt(cap) };
}

/** `findFreezeNotAfter`'s result. */
export interface FreezeNotAfterSearch {
  /** The `not_after` the freeze payload hash commits to; null when none in the range searched does. */
  readonly notAfter: bigint | null;
  /** Candidate seconds hashed (the hint included). */
  readonly tried: number;
  /** The cap stopped the search: later seconds were not tried. */
  readonly truncated: boolean;
}

/**
 * P.G4: the `not_after` a freeze payload hash (v2) commits to
 * (`payloadHash == SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph_hash ||
 * i64le(not_after))`), which neither the autopilot nor the authorization
 * stores. The program uses a freeze only at a time `now <= not_after`, and
 * no earlier than its authorization landed, so `not_after >= authorizedAt`:
 * this tries `hint` first (when in range), then every second from
 * `authorizedAt` up, at most `cap` of them (the SDK signs `not_after` one
 * hour after signing, so a freeze it made is found within about 3,600).
 */
export function findFreezeNotAfter(
  autopilot: PublicKey,
  graphHash: Uint8Array,
  payloadHash: Uint8Array,
  authorizedAt: bigint,
  opts: { readonly hint?: bigint | number | undefined; readonly cap?: number | undefined } = {},
): FreezeNotAfterSearch {
  const cap = opts.cap ?? QSL1.FREEZE_NOT_AFTER_SEARCH_CAP;
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError("the search cap must be a whole number of seconds, 0 or more");
  if (graphHash.length !== 32 || payloadHash.length !== 32) throw new RangeError("graphHash and payloadHash must be 32 bytes");
  const I64_MAX = (1n << 63n) - 1n;
  let tried = 0;
  if (opts.hint !== undefined) {
    const h = BigInt(opts.hint);
    if (h >= authorizedAt && h <= I64_MAX) {
      tried++;
      if (bytesEqual(freezePayload(autopilot, graphHash, h), payloadHash)) return { notAfter: h, tried, truncated: false };
    }
  }
  const room = I64_MAX - authorizedAt + 1n;
  const n = room < BigInt(cap) ? Number(room) : cap;
  const base = sha256.create().update(new TextEncoder().encode("PHX-GRAPH-FRZ-V2")).update(autopilot.toBytes()).update(graphHash);
  const tail = new Uint8Array(8);
  const view = new DataView(tail.buffer);
  const p0 = payloadHash[0]!;
  const p1 = payloadHash[1]!;
  const small = authorizedAt >= 0n && authorizedAt + BigInt(n) <= BigInt(Number.MAX_SAFE_INTEGER);
  const loN = Number(authorizedAt);
  for (let i = 0; i < n; i++) {
    if (small) {
      const t = loN + i;
      view.setUint32(0, t % 0x1_0000_0000, true);
      view.setUint32(4, Math.floor(t / 0x1_0000_0000), true);
    } else view.setBigInt64(0, authorizedAt + BigInt(i), true);
    const d = base.clone().update(tail).digest();
    tried++;
    if (d[0] === p0 && d[1] === p1 && bytesEqual(d, payloadHash)) return { notAfter: authorizedAt + BigInt(i), tried, truncated: false };
  }
  return { notAfter: null, tried, truncated: room > BigInt(cap) };
}

/** The TLV value of extension `type` in a parsed mint (null when absent). */
const extension = (m: ParsedMint, type: number): Uint8Array | null => m.extensions.find((e) => e.type === type)?.data ?? null;

/** The mint's TokenMetadata name, symbol and uri as raw bytes, and the bytes after the uri. Throws when truncated. */
function tokenMetadataBytes(value: Uint8Array): { name: Uint8Array; symbol: Uint8Array; uri: Uint8Array; rest: Uint8Array } {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let off = 64;
  const field = (what: string): Uint8Array => {
    if (off + 4 > value.length) throw new Error(`TokenMetadata ${what} is truncated`);
    const n = view.getUint32(off, true);
    off += 4;
    if (n > value.length - off) throw new Error(`TokenMetadata ${what} is truncated`);
    const b = value.slice(off, off + n);
    off += n;
    return b;
  };
  if (value.length < 64) throw new Error("TokenMetadata is truncated");
  const name = field("name");
  const symbol = field("symbol");
  const uri = field("uri");
  return { name, symbol, uri, rest: value.slice(off) };
}

/** Program and ProgramData accounts, as the loader writes them (null: either is missing; Error: malformed). */
function programInfo(get: (k: PublicKey) => QslAccount | null, program: PublicKey): UpgradeableProgramInfo | Error | null {
  const p = get(program);
  const pdAddr = programDataAddress(program);
  const pd = get(pdAddr);
  if (p === null || pd === null) return null;
  try {
    return upgradeableProgramInfo(
      { address: program, owner: p.owner, lamports: 0, executable: p.executable ?? false, data: p.data },
      { address: pdAddr, owner: pd.owner, lamports: 0, executable: false, data: pd.data },
    );
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** C1.24 for one program: finalized, upgradeable, or unreadable. */
function finality(info: UpgradeableProgramInfo | Error | null | undefined, name: string, program: PublicKey): { state: "final" | "upgradeable" | "invalid"; detail: string } {
  if (info === null || info === undefined) return { state: "invalid", detail: `${name} ${program.toBase58()}: the program or its ProgramData account is missing` };
  if (info instanceof Error) return { state: "invalid", detail: `${name} ${program.toBase58()}: ${info.message}` };
  if (!info.programData.equals(programDataAddress(program))) return { state: "invalid", detail: `${name}: its ProgramData is not PDA(loader; program)` };
  if (!info.executable) return { state: "invalid", detail: `${name} ${program.toBase58()} is not executable` };
  if (info.upgradeAuthority !== null) {
    return { state: "upgradeable", detail: `${name} ${program.toBase58()} can still be upgraded by ${info.upgradeAuthority.toBase58()} (last deployed at slot ${info.lastDeploySlot})` };
  }
  return { state: "final", detail: `${name} ${program.toBase58()} is finalized (upgrade authority None; last deployed at slot ${info.lastDeploySlot})` };
}

interface LpView {
  /** The pool the verdict is taken on, and its positions held by the launch authority. */
  readonly pool: PublicKey;
  readonly poolState: DammPool;
  readonly positions: { readonly address: PublicKey; readonly state: DammPosition }[];
  readonly canonical: boolean;
  readonly otherPools: PublicKey[];
}

/** C1.23's positions: Token-2022 accounts of the launch authority holding 1 unit of an NFT mint, their DAMM v2 positions and pools (§7.6). */
function lpPositions(s: QslSnapshot, get: (k: PublicKey) => QslAccount | null, launchAuthority: PublicKey, cert: QslCertificate): { view: LpView | null; problems: string[] } {
  const problems: string[] = [];
  const found: { address: PublicKey; state: DammPosition; pool: PublicKey; poolState: DammPool }[] = [];
  const dammCodec = idlCodecs().dammV2;
  for (const t of s.launchAuthorityTokenAccounts ?? []) {
    let mint: PublicKey;
    try {
      if (!t.account.owner.equals(T22)) continue;
      const parsed = parseTokenAccount(t.account.owner, t.account.data);
      if (parsed.amount !== 1n || !parsed.owner.equals(launchAuthority)) continue;
      mint = parsed.mint;
    } catch {
      continue; // not a token account
    }
    const positionAddr = dammV2PositionAddress(mint);
    const pa = get(positionAddr);
    if (pa === null || !pa.owner.equals(PROGRAM_IDS.dammV2) || !dammCodec.hasDiscriminator("Position", pa.data)) continue;
    let state: DammPosition;
    try {
      state = decodeDammPosition(pa.data);
    } catch {
      continue;
    }
    if (!state.nftMint.equals(mint)) continue;
    const pool = get(state.pool);
    if (pool === null || !pool.owner.equals(PROGRAM_IDS.dammV2) || !dammCodec.hasDiscriminator("Pool", pool.data)) continue;
    let poolState: DammPool;
    try {
      poolState = decodeDammPool(pool.data);
    } catch {
      continue;
    }
    // A pool of (M, wSOL) that DBC's migration created (its pool authority is the creator).
    if (!poolState.tokenAMint.equals(cert.baseMint) || !poolState.tokenBMint.equals(WSOL_MINT) || !poolState.creator.equals(KNOWN_ACCOUNTS.dbcPoolAuthority)) continue;
    found.push({ address: positionAddr, state, pool: state.pool, poolState });
  }
  if (found.length === 0) {
    problems.push("the launch authority holds no position in a DBC-migrated DAMM v2 pool of (this token, wSOL)");
    return { view: null, problems };
  }
  // The verdict is taken on one pool, preferring the one on the canonical migration config of the fee option.
  const config = DAMM_V2_MIGRATION_CONFIGS[cert.migrationFeeOption];
  const canonical = config === undefined ? null : dammV2PoolAddress(config, cert.baseMint, WSOL_MINT);
  const lockedIn = (pool: PublicKey): bigint => found.filter((f) => f.pool.equals(pool)).reduce((sum, f) => sum + f.state.permanentLockedLiquidity, 0n);
  const pools = [...new Map(found.map((f) => [f.pool.toBase58(), f.pool])).values()];
  const chosen =
    (canonical !== null ? pools.find((p) => p.equals(canonical)) : undefined) ?? pools.slice().sort((a, b) => (lockedIn(b) > lockedIn(a) ? 1 : lockedIn(b) < lockedIn(a) ? -1 : 0))[0]!;
  const inPool = found.filter((f) => f.pool.equals(chosen));
  return {
    view: {
      pool: chosen,
      poolState: inPool[0]!.poolState,
      positions: inPool.map((f) => ({ address: f.address, state: f.state })),
      canonical: canonical !== null && chosen.equals(canonical),
      otherPools: pools.filter((p) => !p.equals(chosen)),
    },
    problems,
  };
}

const sameRecipients = (a: readonly { wallet: PublicKey; bps: number }[], b: readonly { wallet: PublicKey; bps: number }[]): boolean =>
  a.length === b.length && a.every((r, i) => r.wallet.equals(b[i]!.wallet) && r.bps === b[i]!.bps);

const fmtSol = (lamports: bigint): string => {
  const whole = lamports / 1_000_000_000n;
  const frac = lamports % 1_000_000_000n;
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(9, "0").replace(/0+$/, "")}`;
};

/** Throws a RangeError for options that are not whole seconds. */
function checkOptions(opts: EvaluateQsl1Options): void {
  const whole = (v: bigint | number | undefined): boolean => v === undefined || typeof v === "bigint" || Number.isSafeInteger(v);
  const cap = (v: number | undefined): boolean => v === undefined || (Number.isSafeInteger(v) && v >= 0);
  if (!whole(opts.activateAt)) throw new RangeError("activateAt must be whole unix seconds");
  if (!cap(opts.activateAtSearchCap)) throw new RangeError("activateAtSearchCap must be a whole number of seconds, 0 or more");
  if (!whole(opts.freezeNotAfter)) throw new RangeError("freezeNotAfter must be whole unix seconds");
  if (!cap(opts.freezeNotAfterSearchCap)) throw new RangeError("freezeNotAfterSearchCap must be a whole number of seconds, 0 or more");
}

/**
 * Evaluate QSL-1 on accounts already read (pure; QSL-1 §7.2 to §7.9). See
 * `checkQsl1` for the reads; the result is the same for the same accounts
 * and options (`opts`: the autopilot's activation-time and freeze `not_after`
 * hints and search caps, P.G3 and P.G4). Throws a RangeError for options
 * that are not whole seconds.
 */
export function evaluateQsl1(s: QslSnapshot, opts: EvaluateQsl1Options = {}): QslResult {
  if (!(s.mint instanceof PublicKey)) throw new TypeError("mint must be a PublicKey");
  checkOptions(opts);
  const searchCap = opts.activateAtSearchCap ?? QSL1.ACTIVATE_AT_SEARCH_CAP;
  const activateAtHint = opts.activateAt;
  const freezeCap = opts.freezeNotAfterSearchCap ?? QSL1.FREEZE_NOT_AFTER_SEARCH_CAP;
  const freezeHint = opts.freezeNotAfter;
  const M = s.mint;
  const R = new Recorder();
  const get = (k: PublicKey): QslAccount | null => s.accounts.get(k.toBase58()) ?? null;
  const info: QslInfo[] = [];
  const addInfo = (id: string, title: string, status: "pass" | "warn", plain: string, detail: string): void => {
    info.push({ id, title, status, plain, detail });
  };

  // ---------------------------------------------------- step 0: cluster ---
  const cluster = clusterOf(s.genesisHash);
  R.set(
    "cluster",
    cluster === "mainnet"
      ? pass(`genesis hash ${s.genesisHash}: mainnet-beta`)
      : cluster === "devnet"
        ? fail(`genesis hash ${s.genesisHash}: devnet`, "Read from Solana devnet, a test network: QSL-1 levels are only given on mainnet.")
        : cluster === "other"
          ? fail(`genesis hash ${s.genesisHash}: not mainnet-beta (${QSL1.MAINNET_GENESIS_HASH})`, "Read from a network that is not Solana mainnet: QSL-1 levels are only given on mainnet.")
          : fail("the RPC's genesis hash could not be read", "Could not confirm the network: QSL-1 levels are only given on Solana mainnet."),
  );

  // Programs: C1.24 (the launchpad, and the hook while it is active), §6.6 and §8.2.
  const infos = new Map<string, UpgradeableProgramInfo | Error | null>();
  for (const p of PROGRAMS) infos.set(p.toBase58(), programInfo(get, p));
  const trusted = liveTrustedParties(infos);
  for (const [id, name, program, slot, authority] of [
    ["info.dbc", "Meteora DBC", PROGRAM_IDS.dbc, TRUST_ANCHORS.dbcLastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority],
    ["info.dammV2", "Meteora DAMM v2", PROGRAM_IDS.dammV2, TRUST_ANCHORS.dammV2LastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority],
    ["info.token2022", "Token-2022", T22, null, TRUST_ANCHORS.token2022UpgradeAuthority],
  ] as const) {
    const i = infos.get(program.toBase58());
    if (i === null || i === undefined || i instanceof Error) {
      addInfo(id, `${name} code`, "warn", `${name}'s code could not be read.`, `${name} ${program.toBase58()}: ${i instanceof Error ? i.message : "program or ProgramData missing"}`);
      continue;
    }
    const sameAuthority = i.upgradeAuthority !== null && i.upgradeAuthority.equals(authority);
    const sameCode = slot === null || i.lastDeploySlot === slot;
    addInfo(
      id,
      `${name} code`,
      sameAuthority && sameCode ? "pass" : "warn",
      sameAuthority && sameCode
        ? slot === null
          ? `${name} is upgradeable by the same team as when this checker was reviewed.`
          : `${name} is the version this checker was reviewed with; its own team can still upgrade it.`
        : `${name} changed since this checker was reviewed: its team upgraded it or changed who can.`,
      `upgrade authority ${b58(i.upgradeAuthority)} (reviewed: ${authority.toBase58()}), last deployed at slot ${i.lastDeploySlot}${slot === null ? "" : ` (reviewed: ${slot})`}`,
    );
  }

  // Closure-assigned state: `as` keeps TypeScript from narrowing it to its initial null in the outer scope.
  let graduated = null as boolean | null;
  let migrated = null as boolean | null;
  /** §7.6: the LP position is checked (C1.23); null when the pool is unreadable. */
  let lpDue = null as boolean | null;
  let uriMode = null as number | null;
  let certificateVersion = null as number | null;
  /** The programmable component (§6.4, §7.8), once evaluated: what is present, whether its checks pass, the warnings. */
  let prog = null as ProgrammableState | null;
  let rulesView = null as QslRulesView | null;
  let autopilotView = null as QslAutopilotView | null;

  /** C1.24, once graduation is known (the hook counts while it is active, or while that cannot be told). */
  const programFinality = (): { state: "final" | "upgradeable" | "invalid" } => {
    const parts = [finality(infos.get(L.toBase58()), "Noised launchpad", L)];
    const hookActive = graduated !== true;
    if (hookActive) parts.push(finality(infos.get(H.toBase58()), "Noised Launch Guard", H));
    const state = parts.some((p) => p.state === "invalid") ? "invalid" : parts.some((p) => p.state === "upgradeable") ? "upgradeable" : "final";
    const detail = parts.map((p) => p.detail).join("; ") + (hookActive ? "" : "; the hook was revoked at graduation, so its program no longer counts");
    R.set(
      "C1.24",
      state === "final"
        ? pass(detail)
        : state === "upgradeable"
          ? fail(detail, "Noised's programs can still be updated by their team, so no level can be given yet.")
          : fail(detail, "Noised's programs could not be read, so no level can be given."),
    );
    return { state };
  };

  /** §7.9: the level, the candidate flag and the reasons. */
  const finish = (finality: { state: "final" | "upgradeable" | "invalid" }, why: string): QslResult => {
    const checks = R.list(why);
    const byId = new Map(checks.map((c) => [c.id, c]));
    const okAll = (ids: readonly string[]): boolean => ids.every((id) => byId.get(id)!.ok);
    const l1 = QSL1_CONDITION_IDS.filter((id) => id.startsWith("C1.") && id !== "C1.24");
    const l2 = QSL1_CONDITION_IDS.filter((id) => id.startsWith("C2."));
    const wouldBe: QslLevel = !okAll(l1) ? 0 : !okAll(l2) ? 1 : 2;
    const final = byId.get("C1.24")!.ok;
    const onMainnet = byId.get("cluster")!.ok;
    let level: QslLevel = 0;
    let candidate = false;
    if (wouldBe >= 1 && final && onMainnet) level = wouldBe;
    else if (wouldBe >= 1 && (final || finality.state === "upgradeable")) candidate = true;
    const failed = (ids: readonly string[]): QslCheck[] => ids.map((id) => byId.get(id)!).filter((c) => c.status === "fail");
    let blockers: QslCheck[];
    if (level === 2) blockers = [];
    else if (level === 1) blockers = failed(l2);
    else if (candidate) blockers = failed(["cluster", "C1.24"]);
    else blockers = failed(["cluster", ...l1, "C1.24"]);
    const programmable: QslProgrammable = {
      present: prog !== null && (prog.rulesPresent || prog.autopilotPresent),
      verified: prog === null || ((!prog.rulesPresent || prog.rulesHold) && (!prog.autopilotPresent || prog.autopilotHolds)),
      ...(rulesView === null ? {} : { rules: rulesView }),
      ...(autopilotView === null || prog?.autopilotPresent !== true ? {} : { autopilot: autopilotView }),
      checks: R.components(why),
      warnings: prog?.warnings ?? [],
    };
    return {
      standard: "QSL-1",
      mint: M,
      slot: s.slot,
      cluster,
      level,
      candidate,
      wouldBe,
      programmable,
      components: { rules: prog?.rulesHold ?? false, autopilot: prog?.autopilotHolds ?? false },
      graduated,
      migrated,
      checks,
      reasons: blockers.map((c) => c.plain),
      blocking: blockers.map((c) => c.id),
      info,
      trusted,
      uriMode,
      certificateVersion,
      rules: rulesView,
      autopilot: autopilotView,
    };
  };

  // ------------------------------------------------ step 1: certificate ---
  const certAddr = certificateAddress(M);
  const certAcc = get(certAddr);
  if (certAcc === null || !certAcc.owner.equals(L)) {
    R.set("C1.1", fail(certAcc === null ? `no account at ${certAddr.toBase58()}` : `${certAddr.toBase58()} is owned by ${certAcc.owner.toBase58()}, not the launchpad`));
    return finish(programFinality(), "this token has no Noised launch certificate.");
  }
  // §10.2 rule 4: the version of a launchpad certificate of any length, so an unknown version is named, not "no certificate".
  const certDiscriminator = hasDiscriminator(certAcc.data, QSL1.CERTIFICATE.DISCRIMINATOR);
  if (certDiscriminator && certAcc.data.length > 8) certificateVersion = certAcc.data[8]!;
  const unknownVersion = certificateVersion !== null && !isKnownCertificateVersion(certificateVersion) ? certificateVersion : null;
  const invalidWhy = unknownVersion === null ? "the launch certificate is not valid." : `the launch certificate is version ${unknownVersion}, which this checker does not know.`;
  const certLen = certAcc.data.length;
  if ((certLen !== QSL1.CERTIFICATE.LEN && certLen !== QSL1.CERTIFICATE.V3_LEN) || !certDiscriminator) {
    R.set(
      "C1.1",
      fail(
        `the account at ${certAddr.toBase58()} is ${certLen} bytes${certDiscriminator ? "" : " without the Certificate discriminator"}${unknownVersion === null ? "" : `, certificate version ${unknownVersion}`} (expected ${QSL1.CERTIFICATE.V3_LEN} bytes for version ${QSL1.CERTIFICATE.V3_VERSION} or ${QSL1.CERTIFICATE.LEN} bytes for version ${QSL1.CERTIFICATE.VERSION})`,
        unknownVersion === null ? undefined : unknownVersionPlain(unknownVersion),
      ),
    );
    return finish(programFinality(), invalidWhy);
  }
  R.set("C1.1", pass(`certificate ${certAddr.toBase58()}: launchpad-owned, ${certLen} bytes, discriminator ${QSL1.CERTIFICATE.DISCRIMINATOR}`));
  const cert = readCertificate(certAcc.data);
  const [, canonicalBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("certificate"), M.toBytes()], L);
  // A known version has its own length: 487 bytes for version 3, 519 (with rules_hash) for version 4.
  const versionLen = certificateLenOf(cert.version);
  const c12 = verdict(
    [
      ...(versionLen === null ? [`version ${cert.version} (this checker knows versions ${QSL1.CERTIFICATE.KNOWN_VERSIONS.join(" and ")})`] : versionLen === certLen ? [] : [`version ${cert.version} is ${versionLen} bytes, this certificate is ${certLen}`]),
      ...(cert.bump === canonicalBump ? [] : [`bump ${cert.bump} is not the canonical ${canonicalBump}`]),
      ...(cert.baseMint.equals(M) ? [] : [`base_mint ${cert.baseMint.toBase58()} is another mint`]),
      ...(cert.policyVersion === QSL1.CERTIFICATE.POLICY_VERSION ? [] : [`policy_version ${cert.policyVersion} (expected ${QSL1.CERTIFICATE.POLICY_VERSION})`]),
    ],
    `version ${cert.version} (${certLen} bytes), canonical bump ${cert.bump}, base_mint = this mint, safety policy version ${cert.policyVersion}`,
  );
  // An unknown version (or safety policy version) is named in the sentence (§10.2 rule 4).
  const c12Plain =
    c12.status !== "fail"
      ? undefined
      : unknownVersion !== null
        ? unknownVersionPlain(unknownVersion)
        : versionLen !== certLen
          ? `Its launch certificate says version ${cert.version} but does not have that version's size.`
          : cert.policyVersion !== QSL1.CERTIFICATE.POLICY_VERSION
            ? `Its launch certificate follows safety rules version ${cert.policyVersion}, which this checker does not know.`
            : undefined;
  R.set("C1.2", c12Plain === undefined ? c12 : fail(c12.detail, c12Plain));
  R.set("C1.3", checksOutcome(cert));
  if (!R.get("C1.2")!.ok || !R.get("C1.3")!.ok) return finish(programFinality(), invalidWhy);
  /** Version 4 goes with the attestation v3 (message v3, rules_hash) and the hook policy v2 (rule bytes); version 3 with attestation v2 and policy v1. */
  const v4 = cert.version === QSL1.CERTIFICATE.VERSION;
  const certRulesHash = cert.rulesHash ?? new Uint8Array(32);

  // ------------------------------------------------------- step 2: mint ---
  const mintAcc = get(M);
  let pm: ParsedMint | null = null;
  let mintProblem = "";
  if (mintAcc === null) mintProblem = "the mint account does not exist";
  else if (!mintAcc.owner.equals(T22)) mintProblem = `the mint is owned by ${mintAcc.owner.toBase58()}, not Token-2022`;
  else {
    try {
      pm = parseMint(mintAcc.owner, mintAcc.data);
    } catch (e) {
      mintProblem = `the mint does not parse as a Token-2022 mint (${msg(e)})`;
    }
  }
  const mintData = mintAcc?.data ?? new Uint8Array(0);
  const withMint = (f: (m: ParsedMint) => Outcome): (() => Outcome) => () => (pm === null ? fail(mintProblem) : f(pm));
  R.run("C1.4", () => {
    if (mintAcc === null || !mintAcc.owner.equals(T22)) return fail(mintProblem);
    const d = mintAcc.data;
    const problems: string[] = [];
    if (pm === null) problems.push(mintProblem);
    if (!(d.length > 165 && d[165] === 1)) problems.push(`account type byte (165) is ${d[165] ?? "missing"}, not 1 (mint)`);
    if (d[45] !== 1) problems.push(`is_initialized (45) is ${d[45] ?? "missing"}`);
    if (d[44] !== cert.tokenDecimal) problems.push(`${d[44] ?? "no"} decimals, the certificate says ${cert.tokenDecimal}`);
    const supply = d.length >= 44 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(36, true) : null;
    if (supply === null || supply > cert.initialSupply) problems.push(`supply ${supply ?? "missing"} is above the initial supply ${cert.initialSupply}`);
    return verdict(problems, `Token-2022 mint, ${d[44]} decimals, supply ${supply} of ${cert.initialSupply} at launch (burns only lower it)`);
  });
  const tag = (o: number): number | null => (mintData.length >= o + 4 ? new DataView(mintData.buffer, mintData.byteOffset, mintData.byteLength).getUint32(o, true) : null);
  R.run("C1.5", withMint(() => (tag(0) === 0 ? pass("mint_authority tag (0..4) = 0: None") : fail(`mint_authority tag ${tag(0)}: the mint authority is set`))));
  R.run("C1.6", withMint(() => (tag(46) === 0 ? pass("freeze_authority tag (46..50) = 0: None") : fail(`freeze_authority tag ${tag(46)}: the freeze authority is set`))));
  R.run(
    "C1.7",
    withMint((m) => {
      const v = extension(m, ExtensionType.TokenMetadata);
      if (v === null) return fail("no TokenMetadata extension");
      if (v.length < 64) return fail("TokenMetadata is truncated");
      const problems: string[] = [];
      if (!isAllZero(v.subarray(0, 32))) problems.push(`update_authority is ${new PublicKey(v.subarray(0, 32)).toBase58()}`);
      if (!bytesEqual(v.subarray(32, 64), M.toBytes())) problems.push("TokenMetadata names another mint");
      return verdict(problems, "TokenMetadata update_authority = zero key (None), mint = this mint");
    }),
  );
  R.run(
    "C1.8",
    withMint((m) => {
      const v = extension(m, ExtensionType.MetadataPointer);
      if (v === null) return fail("no MetadataPointer extension");
      if (v.length !== 64) return fail(`MetadataPointer is ${v.length} bytes, expected 64`);
      const problems: string[] = [];
      if (!isAllZero(v.subarray(0, 32))) problems.push(`pointer authority is ${new PublicKey(v.subarray(0, 32)).toBase58()}`);
      if (!bytesEqual(v.subarray(32, 64), M.toBytes())) problems.push(`metadata_address is ${new PublicKey(v.subarray(32, 64)).toBase58()}, not the mint`);
      return verdict(problems, "MetadataPointer authority = zero key (None), metadata_address = the mint");
    }),
  );
  R.run(
    "C1.9",
    withMint((m) => {
      const types = m.extensions.map((e) => e.type);
      const sorted = types.slice().sort((a, b) => a - b);
      const problems: string[] = [];
      if (sorted.join() !== [ExtensionType.TransferHook, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].join()) problems.push(`extension types [${types.join(", ")}], expected exactly {14, 18, 19}, each once`);
      if (!isAllZero(m.tlvData.subarray(m.tlvUsedLength))) problems.push("non-zero bytes after the last extension: the TLV data is not well-formed to its end");
      return verdict(problems, "extensions exactly TransferHook (14), MetadataPointer (18), TokenMetadata (19), each once, TLV well-formed to its end");
    }),
  );

  // -------------------------------------- step 3: launch, config, pool ---
  const pdas = launchPdasFromLaunch(cert.launch);
  const launchAcc = get(cert.launch);
  let launch: QslLaunch | null = null;
  let launchProblem = "";
  if (launchAcc === null) launchProblem = `no Launch account at ${cert.launch.toBase58()}`;
  else if (!launchAcc.owner.equals(L)) launchProblem = `${cert.launch.toBase58()} is owned by ${launchAcc.owner.toBase58()}, not the launchpad`;
  else if (launchAcc.data.length !== QSL1.LAUNCH.LEN) launchProblem = `the Launch account is ${launchAcc.data.length} bytes, expected ${QSL1.LAUNCH.LEN}`;
  else if (!hasDiscriminator(launchAcc.data, QSL1.LAUNCH.DISCRIMINATOR)) launchProblem = "the account at cert.launch is not a Launch (discriminator)";
  else launch = readLaunch(launchAcc.data);
  const withLaunch = (f: (l: QslLaunch) => Outcome): (() => Outcome) => () => (launch === null ? fail(`the launch record is unreadable: ${launchProblem}`) : f(launch));
  R.run(
    "C1.17",
    withLaunch((l) =>
      verdict(
        [
          ...(l.version === QSL1.LAUNCH.VERSION ? [] : [`version ${l.version}, expected ${QSL1.LAUNCH.VERSION}`]),
          ...(l.status === QSL1.LAUNCH.STATUS_LIVE ? [] : [`status ${l.status} (${l.status === QSL1.LAUNCH.STATUS_CONFIGURED ? "Configured" : "unknown"}), expected 1 (Live)`]),
        ],
        `Launch ${cert.launch.toBase58()}: launchpad-owned, ${QSL1.LAUNCH.LEN} bytes, version 2, Live`,
      ),
    ),
  );
  R.run(
    "C1.18",
    withLaunch((l) => {
      const p: string[] = [];
      const need = (cond: boolean, why: string): void => {
        if (!cond) p.push(why);
      };
      need(launchAddress(l.creator, l.launchSeed).equals(cert.launch), "the launch address is not PDA(launchpad; launch, creator, launch_seed)");
      need(l.baseMint.equals(M), "base_mint is another mint");
      need(l.pool.equals(cert.pool), "pool differs from the certificate's");
      need(l.dbcConfig.equals(pdas.dbcConfig) && pdas.dbcConfig.equals(cert.dbcConfig), "dbc_config is not PDA(launchpad; dbc-config, launch) = cert.dbc_config");
      need(l.launchAuthority.equals(pdas.launchAuthority), "launch_authority is not PDA(launchpad; authority, launch)");
      need(l.batchAuthority.equals(pdas.batchAuthority), "batch_authority is not PDA(launchpad; batch, launch)");
      need(l.creator.equals(cert.creator), "creator differs from the certificate's");
      need(bytesEqual(l.paramsHash, cert.paramsHash), "params_hash differs from the certificate's");
      need(l.tokenDecimal === cert.tokenDecimal && l.migrationQuoteThreshold === cert.migrationQuoteThreshold && l.migrationFeeOption === cert.migrationFeeOption, "decimals, migration threshold or fee option differ");
      need(l.platformFeeBps === cert.platformFeeBps, "platform fee differs");
      need(sameRecipients(l.recipients, cert.recipients), "fee recipients differ");
      need(l.p2pLocked === cert.p2pLocked, "wallet-to-wallet lock differs");
      need(l.launchTs === cert.launchedAt, "launch_ts is not cert.launched_at");
      need(l.executeEndTs === cert.executeEndTs && cert.executeEndTs === cert.snipeShieldEndTs, "execute_end_ts is not cert.execute_end_ts = cert.snipe_shield_end_ts");
      need(l.guardEndTs === cert.guardEndTs, "guard_end_ts differs");
      return verdict(p, "address, mint, pool, DBC config, authorities, creator, params_hash, fees, recipients, lock and timeline equal the certificate's");
    }),
  );

  // The DBC config (C1.11 to C1.16).
  const cfgAcc = get(cert.dbcConfig);
  let cfg: DbcConfigWithTransferHook | null = null;
  let cfgProblem = "";
  const dbcCodec = idlCodecs().dbc;
  if (cfgAcc === null) cfgProblem = `no DBC config at ${cert.dbcConfig.toBase58()}`;
  else if (!cfgAcc.owner.equals(PROGRAM_IDS.dbc)) cfgProblem = `the DBC config is owned by ${cfgAcc.owner.toBase58()}, not DBC`;
  else if (!dbcCodec.hasDiscriminator("ConfigWithTransferHook", cfgAcc.data)) cfgProblem = "the DBC config is not a ConfigWithTransferHook (discriminator)";
  else if (cfgAcc.data.length < dbcCodec.accountSize("ConfigWithTransferHook")) cfgProblem = "the DBC config is too short";
  else {
    try {
      cfg = decodeDbcConfigWithTransferHook(cfgAcc.data);
    } catch (e) {
      cfgProblem = `the DBC config does not decode (${msg(e)})`;
    }
  }
  const withCfg = (f: (c: DbcConfigWithTransferHook) => Outcome): (() => Outcome) => () => (cfg === null ? fail(cfgProblem) : f(cfg));
  R.run(
    "C1.11",
    withCfg((c) => {
      const k = c.config;
      const p: string[] = [];
      const need = (cond: boolean, why: string): void => {
        if (!cond) p.push(why);
      };
      need(c.transferHookProgram.equals(H), `transfer_hook_program is ${c.transferHookProgram.toBase58()}`);
      need(k.feeClaimer.equals(pdas.launchAuthority) && k.leftoverReceiver.equals(pdas.launchAuthority), "fee_claimer or leftover_receiver is not the launch authority");
      need(k.tokenType === DBC.TOKEN_TYPE_TOKEN_2022, `token_type ${k.tokenType} (expected 1, Token-2022)`);
      need(k.tokenUpdateAuthority === DBC.TOKEN_UPDATE_AUTHORITY_IMMUTABLE, `token_update_authority ${k.tokenUpdateAuthority} (expected 1, immutable)`);
      need(k.migrationOption === DBC.MIGRATION_OPTION_DAMM_V2, `migration_option ${k.migrationOption} (expected 1, DAMM v2)`);
      need(k.collectFeeMode === DBC.COLLECT_FEE_MODE_QUOTE, `collect_fee_mode ${k.collectFeeMode} (expected 0, quote only)`);
      need(k.activationType === DBC.ACTIVATION_TYPE_TIMESTAMP, `activation_type ${k.activationType} (expected 1, timestamp)`);
      need(k.creatorTradingFeePercentage === 0, `creator_trading_fee_percentage ${k.creatorTradingFeePercentage}`);
      need(k.fixedTokenSupplyFlag === 0, `fixed_token_supply_flag ${k.fixedTokenSupplyFlag}`);
      need(k.poolCreationFee === 0n, `pool_creation_fee ${k.poolCreationFee}`);
      need(k.enableFirstSwapWithMinFee === 0, `enable_first_swap_with_min_fee ${k.enableFirstSwapWithMinFee}`);
      need(k.tokenDecimal === cert.tokenDecimal && k.migrationQuoteThreshold === cert.migrationQuoteThreshold && k.migrationFeeOption === cert.migrationFeeOption, "token_decimal, migration_quote_threshold or migration_fee_option differ from the certificate");
      return verdict(p, `config ${cert.dbcConfig.toBase58()}: Launch Guard hook, fees to the launch authority, Token-2022, immutable metadata, DAMM v2, quote-only fees, timestamp activation, no creator fee share, dynamic supply, no creation fee, no first-swap privilege`);
    }),
  );
  R.run(
    "C1.12",
    withCfg(({ config: k }) =>
      k.partnerPermanentLockedLiquidityPercentage === 100 &&
      k.partnerLiquidityPercentage === 0 &&
      k.creatorLiquidityPercentage === 0 &&
      k.creatorPermanentLockedLiquidityPercentage === 0 &&
      k.partnerLiquidityVestingInfo.isInitialized === 0 &&
      k.creatorLiquidityVestingInfo.isInitialized === 0
        ? pass("partner_permanent_locked 100%, partner 0%, creator 0%, creator locked 0%, no liquidity vesting")
        : fail(
            `partner locked ${k.partnerPermanentLockedLiquidityPercentage}%, partner ${k.partnerLiquidityPercentage}%, creator ${k.creatorLiquidityPercentage}%, creator locked ${k.creatorPermanentLockedLiquidityPercentage}%, vesting ${k.partnerLiquidityVestingInfo.isInitialized}/${k.creatorLiquidityVestingInfo.isInitialized}`,
          ),
    ),
  );
  R.run(
    "C1.13",
    withCfg(({ config: k }) =>
      k.migrationFeePercentage === 0 && k.creatorMigrationFeePercentage === 0
        ? pass("migration_fee_percentage 0, creator_migration_fee_percentage 0")
        : fail(`migration fee ${k.migrationFeePercentage}%, creator migration fee ${k.creatorMigrationFeePercentage}%`),
    ),
  );
  R.run(
    "C1.14",
    withCfg(({ config: k }) => {
      const v = k.lockedVestingConfig;
      return v.amountPerPeriod === 0n && v.cliffDurationFromMigrationTime === 0n && v.frequency === 0n && v.numberOfPeriod === 0n && v.cliffUnlockAmount === 0n
        ? pass("locked_vesting_config all zero")
        : fail(`locked vesting configured (amount per period ${v.amountPerPeriod}, cliff unlock ${v.cliffUnlockAmount}, ${v.numberOfPeriod} periods)`);
    }),
  );
  R.run("C1.15", withCfg(({ config: k }) => (k.quoteMint.equals(WSOL_MINT) ? pass(`quote_mint ${WSOL_MINT.toBase58()} (wSOL)`) : fail(`quote_mint ${k.quoteMint.toBase58()}`))));
  R.run(
    "C1.16",
    withCfg(({ config: k }) => {
      const bf = k.poolFees.baseFee;
      if (bf.baseFeeMode !== DBC.BASE_FEE_MODE_LINEAR && bf.baseFeeMode !== DBC.BASE_FEE_MODE_EXPONENTIAL) return fail(`base fee mode ${bf.baseFeeMode} is not a fee schedule`);
      const base = { cliffFeeNumerator: bf.cliffFeeNumerator, firstFactor: bf.firstFactor, secondFactor: bf.secondFactor, thirdFactor: bf.thirdFactor, baseFeeMode: bf.baseFeeMode };
      const floor = minBaseFeeNumerator(base);
      if (floor === null) return fail("the base fee schedule is invalid");
      const d = k.poolFees.dynamicFee;
      const dyn = d.initialized === 0 ? 0n : maxVariableFeeNumerator(d);
      if (dyn === null) return fail("the dynamic fee overflows");
      const duration = feeScheduleDuration(base);
      const p: string[] = [];
      if (!withinFeeCeiling(floor, dyn)) p.push(`base fee after its schedule ${feeNumeratorToBps(floor)} bps + dynamic fee up to ${feeNumeratorToBps(dyn)} bps exceeds 1,000 bps`);
      if (launch === null) p.push(`the schedule's duration cannot be compared with the commit window: ${launchProblem}`);
      else if (duration > BigInt(launch.openDelaySecs)) p.push(`the fee schedule lasts ${duration} s, longer than open_delay_secs ${launch.openDelaySecs}`);
      return verdict(p, `base fee ${feeNumeratorToBps(floor)} bps once its ${duration} s schedule ended, plus at most ${feeNumeratorToBps(dyn)} bps dynamic: at most 1,000 bps together`);
    }),
  );

  // The DBC pool (C1.19) and graduation.
  const poolAcc = get(cert.pool);
  let pool: DbcPoolState | null = null;
  let poolProblem = "";
  if (poolAcc === null) poolProblem = `no DBC pool at ${cert.pool.toBase58()}`;
  else if (!poolAcc.owner.equals(PROGRAM_IDS.dbc)) poolProblem = `the pool is owned by ${poolAcc.owner.toBase58()}, not DBC`;
  else if (!dbcCodec.hasDiscriminator("TransferHookPool", poolAcc.data)) poolProblem = "the pool is not a DBC transfer-hook pool (discriminator)";
  else if (poolAcc.data.length < dbcCodec.accountSize("TransferHookPool")) poolProblem = "the pool account is too short";
  else {
    try {
      pool = decodeDbcTransferHookPool(poolAcc.data).poolState;
    } catch (e) {
      poolProblem = `the pool does not decode (${msg(e)})`;
    }
  }
  if (pool !== null) {
    graduated = pool.isMigrated !== 0 || pool.migrationProgress >= 1 || pool.quoteReserve >= cert.migrationQuoteThreshold;
    migrated = pool.isMigrated !== 0;
    lpDue = lpCheckDue(pool);
  }
  R.run("C1.19", () => {
    if (pool === null) return fail(poolProblem);
    const ps = pool;
    const p: string[] = [];
    if (!dbcPoolAddress(cert.dbcConfig, M, WSOL_MINT).equals(cert.pool)) p.push("the pool is not PDA(DBC; pool, dbc_config, max(M, wSOL), min(M, wSOL))");
    if (!ps.config.equals(cert.dbcConfig)) p.push("the pool's config is not the certificate's");
    if (!ps.creator.equals(pdas.launchAuthority)) p.push("the pool's creator is not the launch authority");
    if (!ps.baseMint.equals(M)) p.push("the pool's base mint is another mint");
    if (!ps.baseVault.equals(dbcTokenVaultAddress(M, cert.pool)) || !ps.quoteVault.equals(dbcTokenVaultAddress(WSOL_MINT, cert.pool))) p.push("the pool's vaults are not the DBC token-vault PDAs");
    const state = migrated
      ? "migrated to DAMM v2"
      : lpDue
        ? "migration_progress 3 (CreatedPool) although is_migrated is 0"
        : graduated
          ? "graduated (curve complete), migration pending"
          : `on the curve, ${ps.quoteReserve} of ${cert.migrationQuoteThreshold} lamports raised`;
    return verdict(p, `pool ${cert.pool.toBase58()} of this launch's config and mint, created by the launch authority; ${state}`);
  });

  // The transfer hook against graduation (C1.10).
  R.run(
    "C1.10",
    withMint((m) => {
      const v = extension(m, ExtensionType.TransferHook);
      if (v === null) return fail("no TransferHook extension");
      if (v.length !== 64) return fail(`TransferHook is ${v.length} bytes, expected 64`);
      const authority = v.subarray(0, 32);
      const program = v.subarray(32, 64);
      if (graduated === null) return fail(`graduation cannot be told: ${poolProblem}`);
      if (graduated) {
        return isAllZero(authority) && isAllZero(program)
          ? pass("graduated: TransferHook authority and program are both None (DBC revoked the hook)", "The launch guard switched off when it graduated: it is a plain token now.")
          : fail(`graduated, but the hook is still program ${new PublicKey(program).toBase58()}, authority ${new PublicKey(authority).toBase58()}`);
      }
      if (isAllZero(program)) return fail("the hook was revoked although the curve has not completed");
      return bytesEqual(program, H.toBytes()) && bytesEqual(authority, KNOWN_ACCOUNTS.dbcPoolAuthority.toBytes())
        ? pass(`before graduation: TransferHook program ${H.toBase58()}, authority ${KNOWN_ACCOUNTS.dbcPoolAuthority.toBase58()} (DBC pool authority)`)
        : fail(`TransferHook program ${new PublicKey(program).toBase58()}, authority ${new PublicKey(authority).toBase58()}`);
    }),
  );

  // The hook policy (C1.21: required while the hook is active, SHOULD after) and account list (C1.22).
  const hookRequired = graduated !== true;
  R.run("C1.21", () => {
    const policyAddr = hookPolicyAddress(M);
    const acc = get(policyAddr);
    const p: string[] = [];
    if (acc === null) p.push(`no hook policy at ${policyAddr.toBase58()}`);
    else if (!acc.owner.equals(H)) p.push(`the hook policy is owned by ${acc.owner.toBase58()}`);
    else if (!hasDiscriminator(acc.data, QSL1.HOOK_POLICY.DISCRIMINATOR)) p.push("not a HookPolicy (discriminator)");
    else if (!v4 && acc.data.length !== QSL1.HOOK_POLICY.V1_LEN) p.push(`the hook policy is ${acc.data.length} bytes, expected ${QSL1.HOOK_POLICY.V1_LEN} (version 1, with a version-3 certificate)`);
    else if (v4 && acc.data.length < QSL1.HOOK_POLICY.LEN) p.push(`the hook policy is ${acc.data.length} bytes, expected at least ${QSL1.HOOK_POLICY.LEN} (version 2, with a version-4 certificate)`);
    else {
      const pol = readHookPolicy(acc.data);
      const need = (cond: boolean, why: string): void => {
        if (!cond) p.push(why);
      };
      need(pol.version === (v4 ? QSL1.HOOK_POLICY.VERSION : QSL1.HOOK_POLICY.V1_VERSION), `version ${pol.version} (expected ${v4 ? QSL1.HOOK_POLICY.VERSION : QSL1.HOOK_POLICY.V1_VERSION} with a version-${cert.version} certificate)`);
      if (v4) {
        // Version 2: exactly 279 + len bytes; rule bytes exactly when the certificate binds rules (their content is P.R4's).
        const len = pol.rulesLen ?? 0;
        need(acc.data.length === QSL1.HOOK_POLICY.RULES_OFFSET + len, `the hook policy is ${acc.data.length} bytes, not 279 + its rules length ${len}`);
        need(len <= QSL1.LAUNCH_RULES.MAX_RULES_LEN, `its rules are ${len} bytes, more than ${QSL1.LAUNCH_RULES.MAX_RULES_LEN}`);
        need((len > 0) === !isAllZero(certRulesHash), len > 0 ? "it holds launch rules the certificate does not bind" : "it holds no launch rules although the certificate binds some");
      }
      need(pol.mint.equals(M), "mint differs");
      need(pol.pool.equals(cert.pool), "pool differs from the certificate's");
      need(pol.baseVault.equals(dbcTokenVaultAddress(M, cert.pool)), "base_vault is not the DBC base vault");
      need(pol.launchTs === cert.launchedAt, "launch_ts is not cert.launched_at");
      need(pol.guardEndTs === cert.guardEndTs, "guard_end_ts differs from the certificate's");
      need(pol.guardEndTs - pol.launchTs <= QSL1.MAX_GUARD_SECS, "the guard lasts more than 72 hours");
      if (launch === null) p.push(`the snipe-shield end cannot be checked: ${launchProblem}`);
      else if (launch.executed === 0) need(pol.snipeShieldEndTs === cert.snipeShieldEndTs, "the batch has not executed, but the snipe shield does not end at the certificate's scheduled end");
      else need(pol.snipeShieldEndTs >= launch.commitEndTs && pol.snipeShieldEndTs < launch.executeEndTs, "the batch executed, but the snipe shield ends outside [commit_end_ts, execute_end_ts)");
      need(pol.snipeShieldEndTs <= pol.launchTs + QSL1.MAX_SNIPE_SHIELD_SECS && pol.snipeShieldEndTs <= pol.guardEndTs, "the snipe shield ends after launch_ts + 3,600 or after the guard");
      need(pol.maxWallet === cert.maxWallet && (cert.maxWallet === 0n || cert.maxWallet >= cert.initialSupply / QSL1.MIN_MAX_WALLET_DIVISOR), "max_wallet differs from the certificate's, or is below 0.1% of the supply");
      need(pol.maxBuy === cert.maxBuy && (cert.maxBuy === 0n || cert.maxBuy >= cert.initialSupply / QSL1.MIN_MAX_BUY_DIVISOR), "max_buy differs from the certificate's, or is below 0.01% of the supply");
      need(pol.p2pLocked === cert.p2pLocked, "p2p_locked differs from the certificate's");
      if (launch === null) p.push("the exempt accounts cannot be checked against the launch");
      else
        need(
          pol.exempt[0]!.equals(launch.batchAuthority) && pol.exempt[1]!.equals(launch.launchAuthority) && pol.exempt[2]!.equals(PublicKey.default) && pol.exempt[3]!.equals(PublicKey.default),
          "exempt is not [batch authority, launch authority, zero, zero]",
        );
    }
    if (p.length === 0) return pass(`hook policy ${policyAddr.toBase58()} equals the certificate: timeline, caps, lock and exempt accounts; the guard ends at ${cert.guardEndTs}`);
    if (!hookRequired) return { status: "warn", detail: `after graduation (a SHOULD): ${p.join("; ")}`, plain: "The launch guard's old settings could not be confirmed (it is switched off now)." };
    return fail(p.join("; "));
  });
  R.run("C1.22", () => {
    if (!hookRequired) return { status: "skip", detail: "after graduation the hook is revoked: its account list is no longer read", plain: "Not needed: the launch guard switched off when it graduated.", notApplicable: true };
    const addr = extraAccountMetaListAddress(M);
    const acc = get(addr);
    if (acc === null) return fail(`no hook account list at ${addr.toBase58()}`);
    if (!acc.owner.equals(H)) return fail(`the hook account list is owned by ${acc.owner.toBase58()}`);
    return bytesEqual(acc.data, fromHex(QSL1.META_LIST_HEX))
      ? pass("the 86 bytes of QSL-1 §5.7: the policy PDA, then the instructions sysvar")
      : fail(`unexpected account list (${acc.data.length} bytes, ${toHex(acc.data).slice(0, 32)}…)`);
  });

  // Fee routing (C1.20).
  R.run("C1.20", () => {
    const p: string[] = [];
    if (cert.platformFeeBps > QSL1.MAX_PLATFORM_FEE_BPS) p.push(`platform fee ${cert.platformFeeBps} bps is above 5,000`);
    const used = cert.recipients.map((r) => !r.wallet.equals(PublicKey.default) || r.bps !== 0);
    const count = used.filter(Boolean).length;
    // The program writes recipients 0..count and leaves the rest zero: the used slots come first.
    if (used.some((u, i) => u && i > 0 && !used[i - 1])) p.push("an unused recipient slot comes before a used one");
    if (count < 1 || count > 4) p.push(`${count} recipients (1 to 4 allowed)`);
    const active = cert.recipients.filter((_, i) => used[i]);
    if (active.some((r) => r.wallet.equals(PublicKey.default) || r.bps === 0)) p.push("a recipient has a zero key or a zero share");
    if (new Set(active.map((r) => r.wallet.toBase58())).size !== active.length) p.push("a recipient appears twice");
    if (active.some((r) => r.wallet.equals(pdas.launchAuthority) || r.wallet.equals(pdas.batchAuthority))) p.push("a recipient is the launch or batch authority");
    const total = active.reduce((sum, r) => sum + r.bps, 0);
    if (total !== QSL1.BPS) p.push(`recipient shares total ${total} bps, not 10,000`);
    return verdict(p, `platform ${cert.platformFeeBps} bps; the rest to ${active.map((r) => `${r.wallet.toBase58()} ${r.bps} bps`).join(", ")}`);
  });

  // ------------------------------------------- step 4: LP after migration ---
  let lp = null as LpView | null;
  R.run("C1.23", () => {
    if (migrated === null || lpDue === null) return fail(`whether it migrated cannot be told: ${poolProblem}`);
    if (!lpDue) {
      return {
        status: "skip",
        detail: graduated ? "graduated, migration pending: the LP position does not exist yet" : "not migrated: the LP lock is the DBC config's (C1.12)",
        plain: "Not needed yet: its liquidity has not moved to its final pool.",
        notApplicable: true,
      };
    }
    // The stricter reading (§7.6): either field saying the liquidity moved makes the LP position required.
    const why = migrated ? "" : "migration_progress is 3 (CreatedPool) although is_migrated is 0, so the LP position is checked as after migration; ";
    if (s.launchAuthorityTokenAccounts === null) return fail(`${why}the launch authority's token accounts were not read`);
    const r = lpPositions(s, get, pdas.launchAuthority, cert);
    if (r.view === null) return fail(why + r.problems.join("; "));
    lp = r.view;
    const locked = lp.positions.reduce((sum, x) => sum + x.state.permanentLockedLiquidity, 0n);
    const p: string[] = [];
    if (locked === 0n) p.push(`no permanently locked liquidity in pool ${lp.pool.toBase58()}`);
    const vesting = lp.positions.find((x) => x.state.vestedLiquidity !== 0n);
    if (vesting !== undefined) p.push(`position ${vesting.address.toBase58()} has vesting liquidity`);
    const others = lp.otherPools.length === 0 ? "" : `; other pools not counted: ${lp.otherPools.map((x) => x.toBase58()).join(", ")}`;
    const o = verdict(p, `pool ${lp.pool.toBase58()}${lp.canonical ? " (canonical migration config)" : ""}: ${locked} permanently locked liquidity in ${lp.positions.length} position(s) held by the launch authority, none vesting${others}`);
    return { ...o, detail: why + o.detail };
  });

  // ------------------------------------------------------ step 5: level 2 ---
  R.run("C2.1", () =>
    (cert.checks & QSL1.PQ_ATTESTED) !== 0 && (cert.checks & QSL1.METADATA_ONCHAIN) !== 0
      ? pass("certificate bits 1024 (PQ_ATTESTED) and 2048 (METADATA_ONCHAIN) are set")
      : fail(`certificate checks ${cert.checks} lack bit 1024 or 2048`),
  );
  const attAddr = attestationAddress(cert.launch);
  const attAcc = get(attAddr);
  const attLen = v4 ? QSL1.ATTESTATION.LEN : QSL1.ATTESTATION.V2_LEN;
  const attVersion = v4 ? QSL1.ATTESTATION.VERSION : QSL1.ATTESTATION.V2_VERSION;
  let att: QslAttestation | null = null;
  let attProblem = "";
  if (attAcc === null) attProblem = `no attestation at ${attAddr.toBase58()}`;
  else if (!attAcc.owner.equals(L)) attProblem = `the attestation is owned by ${attAcc.owner.toBase58()}`;
  else if (attAcc.data.length !== attLen) attProblem = `the attestation is ${attAcc.data.length} bytes, expected ${attLen} (version ${attVersion}, with a version-${cert.version} certificate)`;
  else if (!hasDiscriminator(attAcc.data, QSL1.ATTESTATION.DISCRIMINATOR)) attProblem = "not an Attestation (discriminator)";
  else att = readAttestation(attAcc.data);
  const withAtt = (f: (a: QslAttestation) => Outcome): (() => Outcome) => () => (att === null ? fail(attProblem) : f(att));
  R.run(
    "C2.2",
    withAtt((a) => {
      const p: string[] = [];
      if (a.version !== attVersion) p.push(a.version === 0 ? "the attestation is empty (version 0): signatures only burned their leaves" : `version ${a.version} (expected ${attVersion})`);
      // Version 3 stores the attested rules hash, which launch copied into the certificate (P.R2 binds it to the rules).
      if (a.rulesHash !== null && !bytesEqual(a.rulesHash, certRulesHash)) p.push("its rules_hash is not the certificate's");
      if (!a.launch.equals(cert.launch)) p.push("it names another launch");
      if (isAllZero(cert.pqIdentity)) p.push("the certificate names no identity (all zero)");
      if (!bytesEqual(a.pqIdentity, cert.pqIdentity)) p.push("its identity is not the certificate's pq_identity");
      if (launch === null) p.push(`the launch's pq_identity cannot be read: ${launchProblem}`);
      else if (!bytesEqual(a.pqIdentity, launch.pqIdentity)) p.push("its identity is not the launch's pq_identity");
      if (a.leaf !== cert.pqLeaf || a.leaf >= QSL1.IDENTITY.LEAVES) p.push(`leaf ${a.leaf} is not the certificate's ${cert.pqLeaf}, or not below 1,024`);
      if (a.slot !== cert.attestedSlot) p.push(`slot ${a.slot} is not the certificate's ${cert.attestedSlot}`);
      if (a.signatureLen !== QSL1.ATTESTATION.SIGNATURE_LEN) p.push(`signature length ${a.signatureLen}, expected ${QSL1.ATTESTATION.SIGNATURE_LEN}`);
      return verdict(p, `attestation ${attAddr.toBase58()}: version ${a.version}, this launch, identity ${toHex(a.pqIdentity)}, leaf ${a.leaf}, slot ${a.slot}${a.rulesHash === null ? "" : isAllZero(a.rulesHash) ? ", no rules" : `, rules ${toHex(a.rulesHash)}`}`);
    }),
  );
  R.run(
    "C2.3",
    withAtt((a) => {
      const len = a.notAfter - a.notBefore;
      const p: string[] = [];
      if (len < QSL1.MIN_WINDOW_SECS || len > QSL1.MAX_WINDOW_SECS) p.push(`the window lasts ${len} s (60..=3,600 allowed)`);
      if (cert.launchedAt < a.notBefore || cert.launchedAt > a.notAfter) p.push(`it launched at ${cert.launchedAt}, outside the window ${a.notBefore}..=${a.notAfter}`);
      return verdict(p, `window ${a.notBefore}..=${a.notAfter} (${len} s); launched at ${cert.launchedAt}`);
    }),
  );
  // The identity (C2.5), by the certificate's pq_identity.
  let identity: QslIdentity | null = null;
  let identityProblem = "";
  try {
    const idAddr = identityAddressFromId(cert.pqIdentity);
    const ia = get(idAddr);
    if (ia === null) identityProblem = `no identity account at ${idAddr.toBase58()}`;
    else if (!ia.owner.equals(L)) identityProblem = `the identity account is owned by ${ia.owner.toBase58()}`;
    else if (ia.data.length !== QSL1.IDENTITY.LEN) identityProblem = `the identity account is ${ia.data.length} bytes, expected ${QSL1.IDENTITY.LEN}`;
    else if (!hasDiscriminator(ia.data, QSL1.IDENTITY.DISCRIMINATOR)) identityProblem = "not an Identity (discriminator)";
    else identity = readIdentity(ia.data);
  } catch (e) {
    identityProblem = `the identity account cannot be derived (${msg(e)})`;
  }
  R.run("C2.5", () => {
    if (identity === null) return fail(identityProblem);
    const p: string[] = [];
    if (identity.version !== QSL1.IDENTITY.VERSION) p.push(`version ${identity.version}`);
    if (!bytesEqual(sha256(Uint8Array.of(0x21, ...identity.publicKey)), cert.pqIdentity)) p.push("SHA256(0x21 || public_key) is not pq_identity");
    const leaf = att?.leaf ?? cert.pqLeaf;
    if (!leafBitSet(identity.used, leaf)) p.push(`leaf ${leaf}'s bit is not set`);
    return verdict(p, `identity ${toHex(cert.pqIdentity)}: its public key hashes to it and leaf ${leaf} is marked used (${identity.usedCount} of 1,024 used)`);
  });
  // The record (C2.7), at the address the certificate names = the attested hash's PDA.
  let record = null as TokenMetaAccount | null;
  R.run("C2.7", () => {
    if (att === null) return fail(`the attested record cannot be located: ${attProblem}`);
    const [expected, bump] = tokenMetaPda(cert.launch, att.metadataHash);
    const p: string[] = [];
    if (!cert.metadata.equals(expected)) p.push(`the certificate names ${cert.metadata.toBase58()}, not PDA(launchpad; metadata, launch, attestation.metadata_hash) = ${expected.toBase58()}`);
    const ra = get(cert.metadata);
    if (ra === null) p.push(`no record at ${cert.metadata.toBase58()}`);
    else if (!ra.owner.equals(L)) p.push(`the record is owned by ${ra.owner.toBase58()}`);
    else if (!hasDiscriminator(ra.data, QSL1.TOKEN_META.DISCRIMINATOR)) p.push("not a TokenMeta record (discriminator)");
    else if (ra.data[8] !== QSL1.TOKEN_META.VERSION) p.push(`record version ${ra.data[8]}`);
    else {
      try {
        // Checks the exact size, UTF-8, the content hash and the canonical address and bump of its own launch and hash.
        const r = decodeTokenMeta(cert.metadata, ra.data);
        record = r;
        uriMode = r.flags;
        if (r.bump !== bump) p.push("the record's bump is not canonical");
        if (!r.launch.equals(cert.launch)) p.push("the record belongs to another launch");
        if (!bytesEqual(r.metadataHash, att.metadataHash)) p.push("the record's hash is not the attested metadata_hash");
        const v = validateTokenMeta(r.record);
        if (!v.ok) p.push(`the record breaks the record rules: ${v.errors.join("; ")}`);
      } catch (e) {
        p.push(`the record is invalid (${msg(e)})`);
      }
    }
    return verdict(p, `record ${cert.metadata.toBase58()} at the attested hash's address; its content hashes to ${toHex(att.metadataHash)}${record === null ? "" : ` ("${record.name}", ${record.symbol})`}`);
  });
  // The message (C2.4) and the signature (C2.6), from on-chain data only.
  let message = null as Uint8Array | null;
  R.run("C2.4", () => {
    if (att === null) return fail(attProblem);
    if (launch === null) return fail(`the message cannot be rebuilt: ${launchProblem}`);
    const fields = { launch: cert.launch, paramsHash: launch.paramsHash, creator: launch.creator, metadataHash: att.metadataHash, notBefore: att.notBefore, notAfter: att.notAfter };
    // Message v3 (221 bytes) binds the attestation's rules hash; v2 (189 bytes) is what version-3 certificates' launches signed.
    message = att.rulesHash === null ? attestationMessageV2(fields) : attestationMessage({ ...fields, programId: L, rulesHash: att.rulesHash });
    const what = att.rulesHash === null ? "the record's hash and the window" : "the record's hash, the rules hash and the window";
    return bytesEqual(sha256(message), att.messageHash)
      ? pass(`SHA256 of the ${message.length}-byte message v${att.rulesHash === null ? 2 : 3} rebuilt from the launch, its params_hash and creator, ${what} = ${toHex(att.messageHash)}`)
      : fail("the stored message_hash is not the hash of the message rebuilt from on-chain data");
  });
  R.run("C2.6", () => {
    if (att === null) return fail(attProblem);
    if (identity === null) return fail(`no public key to verify with: ${identityProblem}`);
    if (message === null) return fail("the signed message could not be rebuilt");
    const q = lmsVerify(identity.publicKey, message, att.signature);
    if (q === null) return fail("the LMS signature does not verify under the identity's public key");
    return q === att.leaf ? pass(`LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4 signature verifies at leaf ${q}`) : fail(`the signature verifies at leaf ${q}, not the recorded leaf ${att.leaf}`);
  });
  R.run(
    "C2.8",
    withMint((m) => {
      if (record === null) return fail("there is no valid attested record to compare with");
      const v = extension(m, ExtensionType.TokenMetadata);
      if (v === null) return fail("no TokenMetadata extension");
      const f = tokenMetadataBytes(v);
      const r = record.record;
      const p: string[] = [];
      if (!bytesEqual(f.name, r.name)) p.push("the mint's name bytes are not the record's");
      if (!bytesEqual(f.symbol, r.symbol)) p.push("the mint's symbol bytes are not the record's");
      if (!bytesEqual(f.uri, tokenUriBytes(r))) p.push("the mint's uri is not the one derived from the record");
      if (!(f.rest.length === 4 && isAllZero(f.rest))) p.push("the mint's metadata does not end with u32le(0) (additional metadata)");
      return verdict(p, "the mint's name, symbol and uri are byte for byte the record's (and its derived uri), with no additional metadata");
    }),
  );

  // ---------------------------------------------- step 6: programmable ---
  // §6.4 and §7.8 (revision 0.4): the components that exist, described and checked, with the warnings a holder needs.
  // They never change the level. An account alone means nothing (anyone can create an autopilot): the rules count when
  // the certificate binds them, the autopilot when it runs a graph (only an authorized activation sets one).
  const utf8 = (x: string): Uint8Array => new TextEncoder().encode(x);
  const notUsed = (detail: string, plain: string): Outcome => ({ status: "skip", detail, plain, notApplicable: true });
  const passed = (ids: readonly string[]): boolean => ids.every((id) => R.get(id)?.status === "pass");

  /** P.G3 / P.G4: an authorization re-verified from account state alone (amendment A1), as C2.2 to C2.6 do for the attestation. */
  const checkAuthorization = (addr: PublicKey, kind: number): { auth: QslAuthorization | null; problems: string[] } => {
    const acc = get(addr);
    if (acc === null) return { auth: null, problems: [`no authorization at ${addr.toBase58()}`] };
    if (!acc.owner.equals(L)) return { auth: null, problems: [`the authorization ${addr.toBase58()} is owned by ${acc.owner.toBase58()}, not the launchpad`] };
    if (acc.data.length !== QSL1.AUTHORIZATION.LEN || !hasDiscriminator(acc.data, QSL1.AUTHORIZATION.DISCRIMINATOR)) {
      return { auth: null, problems: [`${addr.toBase58()} is not an Authorization (${acc.data.length} bytes, expected ${QSL1.AUTHORIZATION.LEN}, or another discriminator)`] };
    }
    const a = readAuthorization(acc.data);
    const p: string[] = [];
    if (a.version !== QSL1.AUTHORIZATION.VERSION) p.push(`version ${a.version}`);
    try {
      const at = PublicKey.createProgramAddressSync([utf8(SEEDS.authorization), cert.launch.toBytes(), Uint8Array.of(a.kind), a.payloadHash, Uint8Array.of(a.bump)], L);
      if (!at.equals(addr)) p.push("it is not at PDA(launchpad; auth, launch, [kind], payload_hash) with its stored bump");
    } catch {
      p.push("its stored bump gives no program address");
    }
    if (!a.launch.equals(cert.launch)) p.push("it names another launch");
    if (!bytesEqual(a.pqIdentity, cert.pqIdentity)) p.push("its identity is not the certificate's pq_identity");
    if (a.kind !== kind) p.push(`kind ${a.kind}, expected ${kind} (${kind === QSL1.AUTHORIZATION.KIND_ACTIVATE ? "activate a graph" : "freeze it"})`);
    if (launch === null) p.push(`the signed message cannot be rebuilt: ${launchProblem}`);
    else {
      // "PHX-AUTH-V1" || LAUNCHPAD || launch || creator || kind || payload_hash (140 bytes), from account data only.
      const m = authorizationMessage({ programId: L, launch: cert.launch, creator: launch.creator, kind, payloadHash: a.payloadHash });
      if (!bytesEqual(sha256(m), a.messageHash)) p.push("its message_hash is not the hash of the 140-byte message rebuilt from the launch, its creator, the kind and the payload");
      if (identity === null) p.push(`no public key to verify with: ${identityProblem}`);
      else {
        if (!leafBitSet(identity.used, a.leaf)) p.push(`leaf ${a.leaf}'s bit is not set in the identity's bitmap`);
        if (a.signatureLen !== QSL1.AUTHORIZATION.SIGNATURE_LEN) p.push(`signature length ${a.signatureLen}, expected ${QSL1.AUTHORIZATION.SIGNATURE_LEN}`);
        else {
          const q = lmsVerify(identity.publicKey, m, a.signature);
          if (q === null) p.push("the LMS signature does not verify under the identity's public key");
          else if (q !== a.leaf) p.push(`the signature verifies at leaf ${q}, not the recorded leaf ${a.leaf}`);
        }
      }
    }
    return { auth: a, problems: p };
  };

  // Component R: the launch rules (P.R1 to P.R4).
  const rulesPresent = v4 && !isAllZero(certRulesHash);
  const rulesPda = rulesPresent ? launchRulesPda(cert.launch, certRulesHash) : null;
  let rulesBytes = null as Uint8Array | null;
  if (rulesPda === null) {
    const why = v4 ? "the certificate's rules_hash is zero: the launch has no launch rules" : `a version-${cert.version} certificate binds no launch rules`;
    for (const id of RULES_IDS) R.set(id, notUsed(why, "Not used: it has no launch rules."));
  } else {
    const [rulesAddr, rulesBump] = rulesPda;
    const hashHex = toHex(certRulesHash);
    R.run("P.R1", () =>
      verdict(
        cert.checks === QSL1.CHECKS_WITH_RULES ? [] : [`checks = ${cert.checks}, not 8,191 (the twelve bits and RULES_BOUND)`],
        `certificate version 4 binds rules_hash ${hashHex}; checks = 8,191 (the twelve bits and RULES_BOUND)`,
      ),
    );
    R.run("P.R2", () => {
      if (att === null) return fail(`the attestation is unreadable: ${attProblem}`);
      const p: string[] = [];
      if (att.rulesHash === null || !bytesEqual(att.rulesHash, certRulesHash)) p.push("the attestation does not store the certificate's rules_hash");
      const unsigned = ["C2.4", "C2.5", "C2.6"].filter((id) => R.get(id)?.status !== "pass");
      if (unsigned.length > 0) p.push(`${unsigned.join(", ")} did not pass: the message v3 that carries the rules hash is not shown signed by the identity`);
      return verdict(p, `the attestation stores rules_hash ${hashHex}, and the 221-byte message v3 that includes it is the one its message_hash names and the identity's LMS signature covers (C2.4 to C2.6)`);
    });
    R.run("P.R3", () => {
      const acc = get(rulesAddr);
      if (acc === null) return fail(`no rules record at ${rulesAddr.toBase58()} = PDA(launchpad; rules, launch, rules_hash)`);
      if (!acc.owner.equals(L)) return fail(`the rules record is owned by ${acc.owner.toBase58()}, not the launchpad`);
      if (acc.data.length < QSL1.LAUNCH_RULES.FIXED_LEN || !hasDiscriminator(acc.data, QSL1.LAUNCH_RULES.DISCRIMINATOR)) return fail(`${rulesAddr.toBase58()} is not a LaunchRules record (length or discriminator)`);
      const r = readLaunchRules(acc.data);
      const p: string[] = [];
      if (r.version !== QSL1.LAUNCH_RULES.VERSION) p.push(`version ${r.version}`);
      if (r.bump !== rulesBump) p.push(`bump ${r.bump} is not the canonical ${rulesBump}`);
      if (!r.launch.equals(cert.launch)) p.push("it belongs to another launch");
      if (!bytesEqual(r.rulesHash, certRulesHash)) p.push("it stores another rules_hash");
      if (acc.data.length !== QSL1.LAUNCH_RULES.FIXED_LEN + r.len) p.push(`it is ${acc.data.length} bytes, not 78 + its length ${r.len}`);
      if (r.len < 1 || r.len > QSL1.LAUNCH_RULES.MAX_RULES_LEN) p.push(`its rules are ${r.len} bytes (1 to ${QSL1.LAUNCH_RULES.MAX_RULES_LEN})`);
      rulesBytes = r.bytes;
      if (!bytesEqual(hashRules(r.bytes), certRulesHash)) p.push("its bytes do not hash to rules_hash (SHA256(PHX-RULES-V1 || bytes))");
      if (launch === null) p.push(`the launch's guard cannot be read to verify them: ${launchProblem}`);
      else {
        const v = verifyRules(r.bytes, { guardSecs: launch.guardSecs });
        if (!v.ok) p.push(`the PXR1 verifier refuses them for the launch's ${launch.guardSecs} s guard: ${v.code} (${v.message})`);
      }
      return verdict(p, `rules record ${rulesAddr.toBase58()}: launchpad-owned, version 1, canonical bump, this launch, ${r.len} bytes hashing to rules_hash; the PXR1 verifier accepts them for the launch's ${launch?.guardSecs ?? "?"} s guard`);
    });
    R.run("P.R4", () => {
      const policyAddr = hookPolicyAddress(M);
      const acc = get(policyAddr);
      if (acc === null) return fail(`no hook policy at ${policyAddr.toBase58()}`);
      if (!acc.owner.equals(H)) return fail(`the hook policy is owned by ${acc.owner.toBase58()}`);
      if (acc.data.length < QSL1.HOOK_POLICY.LEN || !hasDiscriminator(acc.data, QSL1.HOOK_POLICY.DISCRIMINATOR)) return fail("the hook policy is not a version-2 HookPolicy (length or discriminator)");
      const pol = readHookPolicy(acc.data);
      const len = pol.rulesLen ?? 0;
      const p: string[] = [];
      if (pol.version !== QSL1.HOOK_POLICY.VERSION) p.push(`policy version ${pol.version}, expected ${QSL1.HOOK_POLICY.VERSION}`);
      if (acc.data.length !== QSL1.HOOK_POLICY.RULES_OFFSET + len) p.push(`the policy is ${acc.data.length} bytes, not 279 + its rules length ${len}`);
      if (rulesBytes === null) p.push("the rules record could not be read to compare with");
      else if (pol.rules === null || !bytesEqual(pol.rules, rulesBytes)) p.push(`its ${len} rule bytes are not the record's ${rulesBytes.length}`);
      return verdict(p, `hook policy ${policyAddr.toBase58()} (version 2) holds exactly the record's ${len} rule bytes`);
    });
  }
  const rulesHold = rulesPresent && passed(RULES_IDS);

  // Component G: the autopilot (P.G1 to P.G5).
  const apAddr = autopilotAddress(cert.launch);
  const apAcc = get(apAddr);
  let ap = null as QslAutopilot | null;
  let apProblem = "";
  let apNote = "";
  let autopilotPresent = false;
  if (apAcc === null) apNote = `no autopilot account at ${apAddr.toBase58()}`;
  else if (!apAcc.owner.equals(AUTOPILOT)) apNote = `the account at ${apAddr.toBase58()} is owned by ${apAcc.owner.toBase58()}, not the autopilot program: no autopilot`;
  else if (apAcc.data.length !== QSL1.AUTOPILOT.LEN || !hasDiscriminator(apAcc.data, QSL1.AUTOPILOT.DISCRIMINATOR)) {
    // The autopilot program's own account at the launch's address, malformed: present, and failing (fail closed).
    autopilotPresent = true;
    apProblem = `the autopilot account is ${apAcc.data.length} bytes${hasDiscriminator(apAcc.data, QSL1.AUTOPILOT.DISCRIMINATOR) ? "" : " without the Autopilot discriminator"} (expected ${QSL1.AUTOPILOT.LEN})`;
  } else {
    ap = readAutopilot(apAcc.data);
    autopilotPresent = !isAllZero(ap.activeGraph);
    if (!autopilotPresent) {
      apNote = `the autopilot ${apAddr.toBase58()} runs no graph${isAllZero(ap.pendingGraph) ? "" : ` (graph ${toHex(ap.pendingGraph)} is queued for ${ap.pendingActivateAt})`}`;
    }
  }
  let graphBytes = null as Uint8Array | null;
  let activateAt = null as bigint | null;
  let activationAuth = null as PublicKey | null;
  let activationAuthorizedAt = null as bigint | null;
  let freezeNotAfter = null as bigint | null;
  let autopilotFinality = null as "final" | "upgradeable" | "invalid" | null;
  if (!autopilotPresent) {
    for (const id of AUTOPILOT_IDS) R.set(id, notUsed(apNote, "Not used: no automation is running for this token."));
  } else {
    const withAp = (f: (a: QslAutopilot) => Outcome): (() => Outcome) => () => (ap === null ? fail(apProblem) : f(ap));
    R.run(
      "P.G1",
      withAp((a) => {
        const [, bump] = PublicKey.findProgramAddressSync([utf8(SEEDS.autopilot), cert.launch.toBytes()], AUTOPILOT);
        const p: string[] = [];
        if (a.version !== QSL1.AUTOPILOT.VERSION) p.push(`version ${a.version}`);
        if (a.bump !== bump) p.push(`bump ${a.bump} is not the canonical ${bump}`);
        if (!a.launch.equals(cert.launch)) p.push("it names another launch");
        if (!a.mint.equals(M)) p.push(a.mint.equals(PublicKey.default) ? "its mint is not bound yet" : `its mint is ${a.mint.toBase58()}, another mint`);
        if (a.frozen !== 0 && a.frozen !== 1) p.push(`frozen byte ${a.frozen} is not a boolean`);
        const pending = isAllZero(a.pendingGraph) ? "no update queued" : `an update to graph ${toHex(a.pendingGraph)} is queued for ${a.pendingActivateAt}`;
        return verdict(p, `autopilot ${apAddr.toBase58()}: this launch and mint, running graph ${toHex(a.activeGraph)} since ${a.activatedAt}; ${a.frozen === 1 ? "frozen" : "not frozen"}; ${pending}`);
      }),
    );
    R.run(
      "P.G2",
      withAp((a) => {
        const gAddr = graphRecordAddress(cert.launch, a.activeGraph);
        const acc = get(gAddr);
        if (acc === null) return fail(`no graph record at ${gAddr.toBase58()} = PDA(autopilot; graph, launch, graph_hash)`);
        if (!acc.owner.equals(AUTOPILOT)) return fail(`the graph record is owned by ${acc.owner.toBase58()}, not the autopilot program`);
        if (acc.data.length < QSL1.GRAPH_RECORD.FIXED_LEN || !hasDiscriminator(acc.data, QSL1.GRAPH_RECORD.DISCRIMINATOR)) return fail(`${gAddr.toBase58()} is not a GraphRecord (length or discriminator)`);
        const g = readGraphRecord(acc.data);
        const [, bump] = PublicKey.findProgramAddressSync([utf8(SEEDS.graphRecord), cert.launch.toBytes(), a.activeGraph], AUTOPILOT);
        const p: string[] = [];
        if (g.version !== QSL1.GRAPH_RECORD.VERSION) p.push(`version ${g.version}`);
        if (g.bump !== bump) p.push(`bump ${g.bump} is not the canonical ${bump}`);
        if (!g.launch.equals(cert.launch)) p.push("it belongs to another launch");
        if (!bytesEqual(g.graphHash, a.activeGraph)) p.push("it stores another graph_hash");
        if (acc.data.length !== QSL1.GRAPH_RECORD.FIXED_LEN + g.len) p.push(`it is ${acc.data.length} bytes, not 78 + its length ${g.len}`);
        if (g.len < 1 || g.len > QSL1.GRAPH_RECORD.MAX_GRAPH_LEN) p.push(`the graph is ${g.len} bytes (1 to ${QSL1.GRAPH_RECORD.MAX_GRAPH_LEN})`);
        graphBytes = g.bytes;
        if (!bytesEqual(hashGraph(g.bytes), a.activeGraph)) p.push("its bytes do not hash to the running graph's hash (SHA256(PHX-GRAPH-V1 || bytes))");
        const v = verifyGraph(g.bytes);
        if (!v.ok) p.push(`the PXG1 verifier refuses them: ${v.code} (${v.message})`);
        return verdict(p, `graph record ${gAddr.toBase58()}: autopilot-owned, version 1, canonical bump, this launch, ${g.len} bytes hashing to the running graph's hash; the PXG1 verifier accepts them`);
      }),
    );
    R.run(
      "P.G3",
      withAp((a) => {
        // Audit 4, A4-S: the autopilot stores the authorization that activated the running graph (active_auth) and the
        // activate_at it signed: the payload is rebuilt directly, no search (and a queued update does not hide it).
        if (!a.activeAuth.equals(PublicKey.default)) {
          const payload = activationPayload(apAddr, a.activeGraph, a.activeActivateAt);
          const [expected] = PublicKey.findProgramAddressSync([utf8(SEEDS.authorization), cert.launch.toBytes(), Uint8Array.of(QSL1.AUTHORIZATION.KIND_ACTIVATE), payload], L);
          const p: string[] = [];
          if (!expected.equals(a.activeAuth)) {
            p.push(
              `active_auth ${a.activeAuth.toBase58()} is not PDA(launchpad; auth, launch, [1], SHA256(PHX-GRAPH-ACT-V1 || autopilot || active_graph || i64le(active_activate_at ${a.activeActivateAt}))) = ${expected.toBase58()}`,
            );
          }
          const r = checkAuthorization(a.activeAuth, QSL1.AUTHORIZATION.KIND_ACTIVATE);
          if (r.auth === null) return fail([...p, ...r.problems].join("; "));
          const auth = r.auth;
          p.push(...r.problems);
          if (!bytesEqual(auth.payloadHash, payload)) p.push("its payload_hash is not the activation of the running graph at active_activate_at");
          // With no update queued, the latest activation used (auth_marks[0]) is the running graph's own.
          if (isAllZero(a.pendingGraph)) {
            const mark = a.authMarks[0];
            if (!mark.key.equals(a.activeAuth)) p.push(`auth_marks[0] (${mark.key.toBase58()}) is not active_auth, though no update is queued`);
            else if (auth.slot !== mark.slot) p.push(`the authorization's slot ${auth.slot} is not auth_marks[0].slot ${mark.slot}`);
          }
          // The program queues an activation no earlier than its approval lands and applies it no earlier than activate_at.
          if (a.activeActivateAt < auth.unixTime) p.push(`active_activate_at ${a.activeActivateAt} is before the authorization landed (${auth.unixTime})`);
          if (a.activeActivateAt > a.activatedAt) p.push(`active_activate_at ${a.activeActivateAt} is after the graph took effect (activated_at ${a.activatedAt})`);
          if (p.length === 0) {
            activateAt = a.activeActivateAt;
            activationAuthorizedAt = auth.unixTime;
            activationAuth = a.activeAuth;
          }
          return verdict(
            p,
            `authorization ${a.activeAuth.toBase58()} (active_auth; kind 1, leaf ${auth.leaf}, landed at ${auth.unixTime}, slot ${auth.slot}): launchpad-owned at PDA(launchpad; auth, launch, [1], payload_hash) with its bump, the certificate's identity, message_hash of the 140-byte message rebuilt from the launch and its creator, the leaf marked used, the LMS signature verified at that leaf; payload_hash activates the running graph at active_activate_at ${a.activeActivateAt}`,
          );
        }
        // An account that stores no active_auth (written before audit round 4): the latest activation used, and a search.
        if (!isAllZero(a.pendingGraph)) {
          return fail(
            `an update to graph ${toHex(a.pendingGraph)} is queued: the latest activation used (auth_marks[0] = ${a.authMarks[0].key.toBase58()}) is the queued graph's, so the running graph's own authorization cannot be read from account state`,
            "An update to its automation is waiting, so the signature that switched on the current plan can't be checked from the chain right now.",
          );
        }
        const mark = a.authMarks[0];
        if (mark.key.equals(PublicKey.default)) return fail("auth_marks[0] is empty: the autopilot records no activation");
        const r = checkAuthorization(mark.key, QSL1.AUTHORIZATION.KIND_ACTIVATE);
        if (r.auth === null) return fail(r.problems.join("; "));
        const auth = r.auth;
        const p = [...r.problems];
        if (auth.slot !== mark.slot) p.push(`the authorization's slot ${auth.slot} is not auth_marks[0].slot ${mark.slot}`);
        // Bound to the running graph: payload_hash = SHA256("PHX-GRAPH-ACT-V1" || autopilot || graph || i64le(activate_at)).
        const found = findActivateAt(apAddr, a.activeGraph, auth.payloadHash, { activatedAt: a.activatedAt, authorizedAt: auth.unixTime }, { hint: activateAtHint, cap: searchCap });
        if (found.activateAt === null) {
          const low = found.truncated ? `${a.activatedAt - BigInt(searchCap) + 1n} (the search cap of ${searchCap} s: pass the activation time, e.g. activate_at of the GraphQueued event)` : `the authorization's unix_time ${auth.unixTime}`;
          p.push(`its payload_hash is not the activation of the running graph at any second from activated_at ${a.activatedAt} down to ${low} (${found.tried} tried)`);
        } else {
          activateAt = found.activateAt;
          activationAuthorizedAt = auth.unixTime;
        }
        if (p.length === 0) activationAuth = mark.key;
        return verdict(
          p,
          `authorization ${mark.key.toBase58()} (kind 1, leaf ${auth.leaf}, landed at ${auth.unixTime}, slot ${auth.slot}): launchpad-owned at PDA(launchpad; auth, launch, [1], payload_hash) with its bump, the certificate's identity, message_hash of the 140-byte message rebuilt from the launch and its creator, the leaf marked used, the LMS signature verified at that leaf; payload_hash activates the running graph at ${found.activateAt} (found after ${found.tried} candidate(s))`,
        );
      }),
    );
    R.run(
      "P.G4",
      withAp((a) => {
        const p: string[] = [];
        const notes: string[] = [];
        const frozen = a.frozen === 1;
        if (frozen) {
          if (!isAllZero(a.pendingGraph)) p.push("frozen with an update queued (a freeze cancels it)");
          const mark = a.authMarks[1];
          if (mark.key.equals(PublicKey.default)) p.push("frozen without a freeze authorization (auth_marks[1] is empty)");
          else {
            const r = checkAuthorization(mark.key, QSL1.AUTHORIZATION.KIND_FREEZE);
            p.push(...r.problems.map((x) => `the freeze authorization: ${x}`));
            let until = "";
            if (r.auth !== null) {
              // Freeze payload v2: SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph || i64le(not_after)), not_after from the authorization's landing up.
              const found = findFreezeNotAfter(apAddr, a.activeGraph, r.auth.payloadHash, r.auth.unixTime, { hint: freezeHint, cap: freezeCap });
              if (found.notAfter === null) {
                p.push(
                  `the freeze authorization is not over the running graph (SHA256(PHX-GRAPH-FRZ-V2 || autopilot || graph || i64le(not_after))) at any not_after from its unix_time ${r.auth.unixTime} up (${found.tried} tried${found.truncated ? `; the search cap of ${freezeCap} s: pass freezeNotAfter, the freeze instruction's not_after` : ""})`,
                );
              } else {
                freezeNotAfter = found.notAfter;
                until = `, usable until ${found.notAfter}, found after ${found.tried} candidate(s)`;
              }
              if (r.auth.slot !== mark.slot) p.push(`the freeze authorization's slot ${r.auth.slot} is not auth_marks[1].slot ${mark.slot}`);
              // logic::check_fresh: a freeze is used only when newer than the latest activation used.
              if (!newerMark(mark, a.authMarks[0])) p.push("the freeze is not newer than the latest activation used");
            }
            notes.push(`frozen by authorization ${mark.key.toBase58()} (kind 2 over the running graph${until}): it can never change`);
          }
        } else if (a.frozen === 0) notes.push("not frozen: another graph can replace it only 72 hours after its authorization, and only with the creator's signature");
        else p.push(`frozen byte ${a.frozen} is not a boolean`);
        // The running graph's own timelock, with P.G3's activation time.
        if (activateAt !== null && activationAuthorizedAt !== null) {
          const waited = activateAt - activationAuthorizedAt;
          notes.push(
            waited >= QSL1.UPDATE_TIMELOCK_SECS
              ? `the running graph took effect ${waited} s after its authorization landed (at least the 72-hour timelock)`
              : `the running graph took effect ${waited} s after its authorization landed: the program allows that only for a first graph (nothing running or queued then), which the accounts cannot show; the autopilot program enforces it (P.G5)`,
          );
        } else notes.push("the running graph's timelock cannot be checked without its activation time (P.G3)");
        // A queued update: auth_marks[0] is its authorization; a replacement waits 72 hours after it landed.
        if (!frozen && !isAllZero(a.pendingGraph)) {
          const r = checkAuthorization(a.authMarks[0].key, QSL1.AUTHORIZATION.KIND_ACTIVATE);
          p.push(...r.problems.map((x) => `the queued update's authorization: ${x}`));
          if (r.auth !== null) {
            if (!bytesEqual(r.auth.payloadHash, activationPayload(apAddr, a.pendingGraph, a.pendingActivateAt))) p.push("the queued update's authorization is not over its graph and activation time");
            else if (a.pendingActivateAt < r.auth.unixTime + QSL1.UPDATE_TIMELOCK_SECS) p.push(`the queued update takes effect at ${a.pendingActivateAt}, less than 72 hours after its authorization landed (${r.auth.unixTime})`);
            else notes.push(`an update to graph ${toHex(a.pendingGraph)} is queued for ${a.pendingActivateAt}, at least 72 hours after its authorization landed`);
          }
        }
        const o = verdict(p, notes.join("; "));
        return o.status === "pass" && frozen ? pass(o.detail, "Its automation is frozen for good, by the creator's quantum-resistant signature.") : o;
      }),
    );
    R.run("P.G5", () => {
      const f = finality(programInfo(get, AUTOPILOT), AUTOPILOT_NAME, AUTOPILOT);
      autopilotFinality = f.state;
      if (f.state === "final") return pass(f.detail);
      return f.state === "upgradeable"
        ? fail(f.detail, "The autopilot program can still be changed by its team.")
        : fail(f.detail, "The autopilot program could not be read, so its automation can't be confirmed.");
    });
  }
  const autopilotHolds = autopilotPresent && passed(["P.G1", "P.G2", "P.G3", "P.G4"]);

  // The views (plain English) and the warnings.
  const warnings: QslWarning[] = [];
  if (rulesPda !== null) {
    let explain: string[] = [];
    if (R.get("P.R3")?.status === "pass" && rulesBytes !== null && launch !== null) {
      try {
        explain = explainRules(rulesBytes, { guardSecs: launch.guardSecs, tokenDecimals: cert.tokenDecimal });
      } catch {
        explain = [];
      }
    }
    rulesView = { hash: certRulesHash, hashHex: toHex(certRulesHash), address: rulesPda[0], bytes: rulesBytes, explain, verified: rulesHold };
    if (!rulesHold) {
      warnings.push({ kind: "rulesUnconfirmed", component: "rules", plain: "Its launch rules could not be fully confirmed on-chain, so what they do is not known for sure." });
    }
    // What the rules really do, from the record's bytes once they verify (P.R3); the hook holds the same bytes when P.R4 passes.
    if (R.get("P.R3")?.status === "pass" && rulesBytes !== null && launch !== null) {
      try {
        const supply = pm?.supply ?? cert.initialSupply;
        const buysOpenAt = Math.max(0, Number(cert.snipeShieldEndTs - cert.launchedAt));
        for (const w of ruleWarnings(rulesBytes, { guardSecs: launch.guardSecs, supply: supply > 0n ? supply : cert.initialSupply, tokenDecimals: cert.tokenDecimal, buysOpenAt })) {
          warnings.push({ kind: w.kind, component: "rules", plain: w.plain, rule: w.rule, from: w.from, to: w.to, ...(w.wallets.length > 0 ? { wallets: w.wallets } : {}) });
        }
      } catch (e) {
        warnings.push({ kind: "rulesUnconfirmed", component: "rules", plain: `Its launch rules could not be summarized (${msg(e)}): read them carefully.` });
      }
    }
  }
  let operatorSteps = 0;
  if (ap !== null) {
    const a = ap;
    let explain: string[] = [];
    if (autopilotPresent && R.get("P.G2")?.status === "pass" && graphBytes !== null) {
      try {
        explain = explainGraph(graphBytes, { tokenDecimals: cert.tokenDecimal });
        if (!a.operator.equals(PublicKey.default)) operatorSteps = decompileGraph(graphBytes).nodes.filter((n) => n.operatorGated).length;
      } catch {
        explain = [];
      }
    }
    autopilotView = {
      address: apAddr,
      activeGraph: a.activeGraph,
      activeGraphHex: toHex(a.activeGraph),
      graphBytes,
      explain,
      frozen: a.frozen === 1,
      operator: a.operator.equals(PublicKey.default) ? null : a.operator,
      operatorSteps,
      activatedAt: a.activatedAt,
      activateAt,
      authorization: activationAuth,
      freezeNotAfter,
      pending: isAllZero(a.pendingGraph) ? null : { graphHash: a.pendingGraph, activateAt: a.pendingActivateAt },
      programFinal: autopilotFinality === "final",
      verified: autopilotHolds,
    };
  }
  if (autopilotPresent) {
    if (!autopilotHolds) warnings.push({ kind: "autopilotUnconfirmed", component: "autopilot", plain: "Its automation could not be fully confirmed on-chain, so what it does is not known for sure." });
    if (ap !== null && operatorSteps > 0) {
      warnings.push({
        kind: "operator",
        component: "autopilot",
        plain: `${operatorSteps === 1 ? "One automation step is" : `${operatorSteps} automation steps are`} run by a wallet the creator chose (${ap.operator.toBase58()}), which decides when and how much, within fixed limits.`,
        wallets: [ap.operator.toBase58()],
      });
    }
    if (ap !== null && !isAllZero(ap.pendingGraph) && ap.frozen !== 1) {
      const when = new Date(Number(ap.pendingActivateAt) * 1000).toISOString().slice(0, 16).replace("T", " ");
      warnings.push({ kind: "updateQueued", component: "autopilot", plain: `A new automation plan is already queued: it can take over from ${when} UTC.` });
    }
    if (ap !== null && ap.frozen === 0) {
      warnings.push({ kind: "notFrozen", component: "autopilot", plain: "Its automation is not frozen: the creator can switch to a new plan, which takes over 72 hours after it is approved." });
    }
    if (autopilotFinality === "upgradeable") warnings.push({ kind: "autopilotUpgradeable", component: "autopilot", plain: "The autopilot program can still be changed by its team." });
  }
  warnings.sort((x, y) => WARNING_ORDER[x.kind] - WARNING_ORDER[y.kind]);
  prog = { rulesPresent, rulesHold, autopilotPresent, autopilotHolds, warnings };

  // ------------------------------------------- §6.6 informational checks ---
  if (launch !== null) {
    const l = launch;
    const threshold = l.migrationQuoteThreshold;
    const shareBps = threshold === 0n ? 0 : Number((l.batchTotalCap * 10_000n) / threshold);
    const wallets = l.batchWalletCap === 0n ? null : (l.batchTotalCap + l.batchWalletCap - 1n) / l.batchWalletCap;
    const weak = l.batchTotalCap < threshold / 10n || (wallets !== null && wallets > 100n);
    addInfo(
      "info.batch",
      "Fair-open batch size",
      weak ? "warn" : "pass",
      weak ? "The fair-open batch is small, so the opening may be a race." : "The fair-open batch is big enough for a fair opening.",
      `batch cap ${fmtSol(l.batchTotalCap)} SOL (${shareBps / 100}% of the ${fmtSol(threshold)} SOL threshold)${wallets === null ? ", no per-wallet cap" : `, per-wallet cap ${fmtSol(l.batchWalletCap)} SOL (at least ${wallets} wallets to fill it)`}`,
    );
    if (l.executed === 0 && pool !== null) {
      addInfo(
        "info.firstTrade",
        "The batch is the first trade",
        pool.hasSwap === 0 ? "pass" : "warn",
        pool.hasSwap === 0 ? "Nobody has traded before the fair-open batch." : "Someone traded before the fair-open batch: every commit will be refunded.",
        `has_swap = ${pool.hasSwap} while the batch is pending`,
      );
    }
  }
  if (graduated === true && migrated === false && lpDue === false) addInfo("info.graduation", "Move to the final pool", "pass", "It graduated; anyone can now move it to its final pool.", "curve complete, DBC migration to DAMM v2 pending (permissionless)");
  if (lp !== null) {
    const v = lp;
    addInfo(
      "info.dammPool",
      "Final pool open for trading",
      v.poolState.poolStatus === DAMM_POOL_STATUS_ENABLED ? "pass" : "warn",
      v.poolState.poolStatus === DAMM_POOL_STATUS_ENABLED ? "Its final pool is open for trading." : "Meteora switched its final pool off: trading stopped, the locked liquidity stays locked.",
      `DAMM v2 pool ${v.pool.toBase58()} status ${v.poolState.poolStatus}`,
    );
    try {
      const f = compareDammPoolFee(v.poolState, cert.migrationFeeOption);
      const tier = MIGRATION_FEE_TIERS_BPS[cert.migrationFeeOption];
      addInfo(
        "info.dammFee",
        "Final pool fee",
        f.matches ? "pass" : "warn",
        f.matches ? `Its final pool charges the ${tier === undefined ? "chosen" : `${tier / 100}%`} fee set at launch, plus Meteora's usual fee that rises with volatility.` : "Meteora changed its final pool's fee after graduation.",
        f.matches ? `matches DBC's migration for fee option ${cert.migrationFeeOption}; at most ${f.maxTotalFeeNumerator === null ? "?" : dammFeePercent(f.maxTotalFeeNumerator)} per trade` : f.differences.join("; "),
      );
    } catch (e) {
      addInfo("info.dammFee", "Final pool fee", "warn", "Its final pool's fee could not be read.", msg(e));
    }
  }
  if (uriMode !== null) {
    addInfo(
      "info.uri",
      "Token link",
      uriMode === 2 ? "warn" : "pass",
      uriMode === 2 ? "Its icon link was chosen by the creator; what it shows can change." : uriMode === 1 ? "Its details travel inside the token: nothing is loaded from elsewhere." : "Its link is empty: nothing is loaded from elsewhere.",
      `record flags ${uriMode} (${uriMode === 2 ? "EXTERNAL_URI: only the link is signed" : uriMode === 1 ? "INLINE_URI" : "no uri"})`,
    );
  }
  if (identity !== null) {
    const id = identity;
    addInfo(
      "info.leaves",
      "Creator identity keys used",
      id.usedCount >= 1_000 ? "warn" : "pass",
      id.usedCount >= 1_000 ? `The creator's identity has used ${id.usedCount} of its 1,024 one-time keys and is almost spent.` : `The creator's identity has used ${id.usedCount} of its 1,024 one-time keys.`,
      `used_count ${id.usedCount}`,
    );
  }

  return finish(programFinality(), "an earlier condition stopped the check.");
}

// ---------------------------------------------------------------- reads ---

const toAccount = (a: AccountInfo<Buffer | Uint8Array> | null): QslAccount | null =>
  a === null ? null : { owner: a.owner, data: new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength), executable: a.executable };

/**
 * Evaluate QSL-1 for `mint` from live accounts (QSL-1 §7): the genesis hash,
 * then the reads of §7.10 at `opts.commitment` (default `finalized`), each no
 * older than the one before, then `evaluateQsl1`. Never reads a URL or uses
 * `getProgramAccounts`. Throws only when the RPC fails; an RPC whose genesis
 * hash cannot be read gives `cluster: "unknown"` (no level).
 */
export async function checkQsl1(conn: Connection, mint: PublicKey, opts: CheckQsl1Options = {}): Promise<QslResult> {
  if (!(mint instanceof PublicKey)) throw new TypeError("mint must be a PublicKey");
  const commitment = opts.commitment ?? "finalized";
  if (commitment !== "finalized" && commitment !== "confirmed") throw new RangeError('commitment must be "finalized" or "confirmed"');
  checkOptions(opts);
  const accounts = new Map<string, QslAccount | null>();
  let slot: number | null = null;
  const config = (): { commitment: "finalized" | "confirmed"; minContextSlot?: number } => (slot === null ? { commitment } : { commitment, minContextSlot: slot });
  const read = async (keys: readonly PublicKey[]): Promise<void> => {
    const todo = [...new Map(keys.filter((k) => !accounts.has(k.toBase58())).map((k) => [k.toBase58(), k])).values()];
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      const res = await conn.getMultipleAccountsInfoAndContext(chunk, config());
      if (res.value.length !== chunk.length) throw new Error("the RPC returned a different number of accounts than requested");
      slot = Math.max(slot ?? 0, res.context.slot);
      chunk.forEach((k, j) => accounts.set(k.toBase58(), toAccount(res.value[j] ?? null)));
    }
  };

  let genesisHash: string | null = null;
  try {
    const h = await conn.getGenesisHash();
    genesisHash = typeof h === "string" && h !== "" ? h : null;
  } catch {
    genesisHash = null;
  }

  // Steps 0 and 1 (§7.2, §7.3): the mint, the certificate, the hook accounts, the programs (merged into one read).
  const certAddr = certificateAddress(mint);
  await read([mint, certAddr, hookPolicyAddress(mint), extraAccountMetaListAddress(mint), ...PROGRAMS, ...PROGRAMS.map(programDataAddress)]);
  const certAcc = accounts.get(certAddr.toBase58()) ?? null;
  let launchAuthorityTokenAccounts: { address: PublicKey; account: QslAccount }[] | null = null;
  const certLen = certAcc?.data.length ?? 0;
  if (certAcc !== null && certAcc.owner.equals(L) && (certLen === QSL1.CERTIFICATE.LEN || certLen === QSL1.CERTIFICATE.V3_LEN) && hasDiscriminator(certAcc.data, QSL1.CERTIFICATE.DISCRIMINATOR)) {
    const cert = readCertificate(certAcc.data);
    // Step 3 (§7.5): the launch, the DBC config and pool, the attestation, the identity and the record; for the
    // programmable component (§7.8), the rules record the certificate binds and the launch's autopilot.
    const keys = [cert.launch, cert.dbcConfig, cert.pool, attestationAddress(cert.launch), cert.metadata];
    if (!isAllZero(cert.pqIdentity)) keys.push(identityAddressFromId(cert.pqIdentity));
    if (cert.rulesHash !== null && !isAllZero(cert.rulesHash)) keys.push(launchRulesPda(cert.launch, cert.rulesHash)[0]);
    const apAddr = autopilotAddress(cert.launch);
    keys.push(apAddr);
    await read(keys);
    // Step 4 (§7.6): after migration (either field: the stricter reading, as C1.23 checks it), the launch authority's
    // position NFTs, their positions and pools.
    const poolAcc = accounts.get(cert.pool.toBase58()) ?? null;
    let lpDue = false;
    try {
      lpDue = poolAcc !== null && poolAcc.owner.equals(PROGRAM_IDS.dbc) && lpCheckDue(decodeDbcTransferHookPool(poolAcc.data).poolState);
    } catch {
      lpDue = false; // reported by C1.19
    }
    if (lpDue) {
      const authority = launchPdasFromLaunch(cert.launch).launchAuthority;
      const res = await conn.getTokenAccountsByOwner(authority, { programId: T22 }, config());
      slot = Math.max(slot ?? 0, res.context.slot);
      launchAuthorityTokenAccounts = res.value.map((t) => ({ address: t.pubkey, account: toAccount(t.account)! }));
      const nftMints: PublicKey[] = [];
      for (const t of launchAuthorityTokenAccounts) {
        try {
          const parsed = parseTokenAccount(t.account.owner, t.account.data);
          if (parsed.amount === 1n && parsed.owner.equals(authority)) nftMints.push(parsed.mint);
        } catch {
          // not a token account
        }
      }
      const positions = nftMints.map(dammV2PositionAddress);
      await read(positions);
      const pools: PublicKey[] = [];
      for (const p of positions) {
        const acc = accounts.get(p.toBase58()) ?? null;
        if (acc === null || !acc.owner.equals(PROGRAM_IDS.dammV2) || !idlCodecs().dammV2.hasDiscriminator("Position", acc.data)) continue;
        try {
          pools.push(decodeDammPosition(acc.data).pool);
        } catch {
          // reported by C1.23
        }
      }
      await read(pools);
    }
    // Step 6 (§7.8): an autopilot that runs a graph: the graph's record, the authorizations it used last (activate,
    // freeze) and the autopilot program (P.G5), in one more read.
    const apAcc = accounts.get(apAddr.toBase58()) ?? null;
    if (apAcc !== null && apAcc.owner.equals(AUTOPILOT) && apAcc.data.length === QSL1.AUTOPILOT.LEN && hasDiscriminator(apAcc.data, QSL1.AUTOPILOT.DISCRIMINATOR)) {
      const ap = readAutopilot(apAcc.data);
      if (!isAllZero(ap.activeGraph)) {
        const more = [graphRecordAddress(cert.launch, ap.activeGraph), AUTOPILOT, programDataAddress(AUTOPILOT)];
        for (const m of ap.authMarks.slice(0, 2)) if (!m.key.equals(PublicKey.default)) more.push(m.key);
        // Audit 4, A4-S: the authorization that activated the running graph (P.G3 reads it directly).
        if (!ap.activeAuth.equals(PublicKey.default) && !more.some((k) => k.equals(ap.activeAuth))) more.push(ap.activeAuth);
        await read(more);
      }
    }
  }
  return evaluateQsl1(
    { mint, genesisHash, slot, accounts, launchAuthorityTokenAccounts },
    { activateAt: opts.activateAt, activateAtSearchCap: opts.activateAtSearchCap, freezeNotAfter: opts.freezeNotAfter, freezeNotAfterSearchCap: opts.freezeNotAfterSearchCap },
  );
}


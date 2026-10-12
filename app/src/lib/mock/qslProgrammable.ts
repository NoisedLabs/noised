/**
 * MOCK `checkQsl1`'s programmable component (QSL-1 revision 0.4 §6.4): the creator's launch rules and automation as a
 * description with warnings, never a level, in the SDK's shape (`QslProgrammable`), built from the simulated chain:
 *   - the launch rules the certificate binds (the verification report's `rules`), explained and warned about with the
 *     SDK's own `explainRules` and `ruleWarnings` (insider-only buying, blocked buys, transfer limits, rules longer than
 *     an hour, rules that do nothing);
 *   - the running autopilot (the simulated autopilot program), explained with the SDK's `explainGraph`, with the
 *     warnings `checkQsl1` gives: steps an operator runs, a queued change, not frozen, and the autopilot program still
 *     upgradeable (the demo's programs are not final, like every test network's).
 * The words are the SDK's (copied from `checkQsl1` where it builds them inline); test/qsl.test.ts compares them.
 */
import { decompileGraph, explainGraph, explainRules, ruleWarnings } from "@noisedlabs/sdk/programmable";
import type { VerificationReport } from "@noisedlabs/sdk";
import type { Connection } from "@solana/web3.js";

import type { QslProgrammableCheck, SdkQslProgrammable } from "../qsl";
import { programmableMock } from "./programmable";

/** The SDK's order of warnings, most serious first (qsl/check.ts WARNING_ORDER). */
const WARNING_ORDER: Readonly<Record<string, number>> = {
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

/** The SDK's P.R1..P.G5 titles and sentences (qsl/check.ts). */
const CHECKS: Readonly<Record<string, { component: "rules" | "autopilot"; title: string; pass: string; fail: string }>> = {
  "P.R1": { component: "rules", title: "Launch rules recorded", pass: "Its launch certificate records the launch rules its creator signed.", fail: "Its launch certificate does not record its launch rules correctly." },
  "P.R2": { component: "rules", title: "Rules signed by the creator", pass: "The creator's quantum-resistant signature covers these launch rules.", fail: "The creator's signature does not cover these launch rules." },
  "P.R3": { component: "rules", title: "Rules stored on-chain and valid", pass: "Its launch rules are stored on-chain exactly as signed, and they are valid.", fail: "Its launch rules are missing, changed or not valid." },
  "P.R4": { component: "rules", title: "Launch guard holds the rules", pass: "The launch guard enforces exactly these rules.", fail: "The launch guard does not hold exactly these rules." },
  "P.G1": { component: "autopilot", title: "Automation set up for this token", pass: "Its automation belongs to this token and a plan is running.", fail: "Its automation is not set up correctly for this token." },
  "P.G2": { component: "autopilot", title: "Automation plan stored and valid", pass: "Its automation plan is stored on-chain and is valid.", fail: "Its automation plan is missing, changed or not valid." },
  "P.G3": { component: "autopilot", title: "Plan switched on by the creator", pass: "The creator's quantum-resistant signature switched on this plan (checked just now).", fail: "The signature that switched on this plan could not be confirmed." },
  "P.G4": { component: "autopilot", title: "Changes wait, freezes are signed", pass: "Changes to its automation wait 72 hours, and only the creator's signature can freeze it.", fail: "Its automation's waiting period or freeze could not be confirmed." },
  "P.G5": { component: "autopilot", title: "Autopilot program is final", pass: "The autopilot program is final: nobody can change it.", fail: "The autopilot program could not be confirmed final." },
};

const check = (id: string, status: "pass" | "fail" | "skip", detail: string, plain?: string): QslProgrammableCheck => {
  const c = CHECKS[id];
  if (!c) throw new Error(`unknown check ${id}`);
  return { id, component: c.component, title: c.title, status, ok: status !== "fail", plain: plain ?? (status === "fail" ? c.fail : status === "skip" ? `Not present: ${c.title.toLowerCase()} does not apply.` : c.pass), detail };
};

type Warning = SdkQslProgrammable["warnings"][number];

/** The programmable component of a mint's QSL-1 result on the simulated chain (null without a certificate). */
export async function mockQslProgrammable(conn: Connection, report: VerificationReport): Promise<SdkQslProgrammable | null> {
  const cert = report.certificate;
  if (cert === null) return null;
  const warnings: Warning[] = [];
  const checks: QslProgrammableCheck[] = [];
  const guardSecs = Number(cert.guardEndTs - cert.launchedAt);
  const tokenDecimals = cert.tokenDecimal;

  // Launch rules: present when the certificate binds a rules hash.
  const r = report.rules;
  let rules: { explain: string[] } | null = null;
  let rulesHold = true;
  if (r !== null && r.address !== null) {
    rulesHold = r.verified && r.bytes.length > 0;
    for (const id of ["P.R1", "P.R2", "P.R3", "P.R4"]) checks.push(check(id, rulesHold ? "pass" : "fail", `rules_hash ${r.hash}, record ${r.address.toBase58()} (simulated chain)`));
    let explain: string[] = [];
    if (rulesHold) {
      try {
        explain = explainRules(r.bytes, { guardSecs, tokenDecimals });
        const buysOpenAt = Math.max(0, Number(cert.snipeShieldEndTs - cert.launchedAt));
        for (const w of ruleWarnings(r.bytes, { guardSecs, supply: cert.initialSupply, tokenDecimals, buysOpenAt })) {
          warnings.push({ kind: w.kind, component: "rules", plain: w.plain });
        }
      } catch (e) {
        warnings.push({ kind: "rulesUnconfirmed", component: "rules", plain: `Its launch rules could not be summarized (${e instanceof Error ? e.message : String(e)}): read them carefully.` });
      }
    } else {
      warnings.push({ kind: "rulesUnconfirmed", component: "rules", plain: "Its launch rules could not be fully confirmed on-chain, so what they do is not known for sure." });
    }
    rules = { explain };
  } else {
    for (const id of ["P.R1", "P.R2", "P.R3", "P.R4"]) checks.push(check(id, "skip", "the certificate binds no launch rules"));
  }

  // Automation: present when the launch's autopilot runs a graph.
  let automation: { explain: string[] } | null = null;
  let autopilotHolds = true;
  const info = await programmableMock.fetchAutopilot(conn, cert.launch).catch(() => null);
  if (info !== null && info.graphHash !== null) {
    const bytes = await programmableMock.fetchGraphBytes(conn, cert.launch, info.graphHash).catch(() => null);
    autopilotHolds = bytes !== null;
    let explain: string[] = [];
    let operatorSteps = 0;
    if (bytes !== null) {
      try {
        explain = explainGraph(bytes, { tokenDecimals });
        if (info.operator !== null) operatorSteps = decompileGraph(bytes).nodes.filter((n) => n.operatorGated).length;
      } catch {
        autopilotHolds = false;
      }
    }
    for (const id of ["P.G1", "P.G2", "P.G3", "P.G4"]) checks.push(check(id, autopilotHolds ? "pass" : "fail", `autopilot ${info.address.toBase58()} (simulated chain)`));
    // Like every test network's, the demo's programs are not final.
    checks.push(check("P.G5", "fail", "Noised Autopilot: upgradeable on this network (simulated chain)", "The autopilot program can still be changed by its team."));
    if (!autopilotHolds) warnings.push({ kind: "autopilotUnconfirmed", component: "autopilot", plain: "Its automation could not be fully confirmed on-chain, so what it does is not known for sure." });
    if (info.operator !== null && operatorSteps > 0) {
      warnings.push({
        kind: "operator",
        component: "autopilot",
        plain: `${operatorSteps === 1 ? "One automation step is" : `${operatorSteps} automation steps are`} run by a wallet the creator chose (${info.operator.toBase58()}), which decides when and how much, within fixed limits.`,
      });
    }
    if (info.pending !== null && !info.frozen) {
      const when = new Date(info.pending.activateAt * 1000).toISOString().slice(0, 16).replace("T", " ");
      warnings.push({ kind: "updateQueued", component: "autopilot", plain: `A new automation plan is already queued: it can take over from ${when} UTC.` });
    }
    if (!info.frozen) warnings.push({ kind: "notFrozen", component: "autopilot", plain: "Its automation is not frozen: the creator can switch to a new plan, which takes over 72 hours after it is approved." });
    warnings.push({ kind: "autopilotUpgradeable", component: "autopilot", plain: "The autopilot program can still be changed by its team." });
    automation = { explain };
  } else {
    for (const id of ["P.G1", "P.G2", "P.G3", "P.G4", "P.G5"]) checks.push(check(id, "skip", "no automation plan is running"));
  }

  warnings.sort((x, y) => (WARNING_ORDER[x.kind] ?? 99) - (WARNING_ORDER[y.kind] ?? 99));
  const present = rules !== null || automation !== null;
  return {
    present,
    verified: (rules === null || rulesHold) && (automation === null || autopilotHolds),
    ...(rules !== null ? { rules } : {}),
    ...(automation !== null ? { autopilot: automation } : {}),
    checks,
    warnings: present ? warnings : [],
  };
}

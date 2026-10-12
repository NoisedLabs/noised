/**
 * Short terminal names for the verification report's checks (SDK and
 * simulated-chain ids): "mint authority ........ none". Shared by the home
 * page's verify terminal and the command palette, so both say the same thing.
 * Display only: the full sentence stays available (title / detail rows).
 */
import { certificateCheckCount } from "../lib/display";
import type { LaunchPhase, VerificationCheck } from "../lib/noised";

/** "n/n": every launch-time check the SDK's complete certificate records (`CERTIFICATE_ALL_CHECKS`). */
const ALL_CHECKS = `${certificateCheckCount()}/${certificateCheckCount()}`;

/** Short terminal names for the report's checks (SDK and simulated-chain ids). */
export const SHORT_CHECKS: Record<string, [string, string]> = {
  "certificate.exists": ["launch certificate", "found"],
  "certificate.account": ["certificate ↔ mint", "linked"],
  "certificate.launch": ["cert ↔ launch ↔ pool", "linked"],
  "certificate.policy": ["safety policy", "current"],
  "certificate.params": ["params hash", "match"],
  "certificate.checks": ["launch-time checks", ALL_CHECKS],
  "certificate.bit1": ["mint authority", "none"],
  "mint.mintAuthority": ["mint authority", "none"],
  "certificate.bit2": ["freeze authority", "none"],
  "mint.freezeAuthority": ["freeze authority", "none"],
  "certificate.bit4": ["metadata authority", "none"],
  "mint.metadata": ["metadata authority", "none"],
  "certificate.bit8": ["metadata pointer", "self, locked"],
  "mint.metadataPointer": ["metadata pointer", "self, locked"],
  "certificate.bit16": ["token extensions", "exact set"],
  "mint.extensions": ["token extensions", "exact set"],
  "certificate.bit32": ["transfer hook", "launch guard"],
  "mint.transferHook": ["transfer hook", "launch guard"],
  "certificate.bit64": ["graduated liquidity", "locks 100%"],
  "dbc.lpLocked": ["graduated liquidity", "locks 100%"],
  "certificate.bit128": ["migration fee", "0%"],
  "dbc.noMigrationFee": ["migration fee", "0%"],
  "certificate.bit256": ["creator allocation", "none"],
  "dbc.noCreatorAllocation": ["creator allocation", "none"],
  "certificate.bit512": ["quote token", "wSOL"],
  "certificate.bit1024": ["quantum signature", "on record"],
  "certificate.bit2048": ["token details", "on-chain"],
  "pq.origin": ["quantum signature", "checked"],
  "metadata.onchain": ["token details", "on-chain"],
  "metadata.match": ["name & symbol", "match record"],
  "metadata.icon": ["token icon", "nothing linked"],
  "dbc.quoteWsol": ["quote token", "wSOL"],
  "mint.program": ["token program", "token-2022"],
  "mint.supply": ["decimals & supply", "match"],
  "launch.account": ["launch account", "matches"],
  "launch.policy": ["launch parameters", "in policy"],
  "launch.phase": ["current phase", "read"],
  "dbc.config": ["dbc config", "fixed values"],
  "dbc.fees": ["trading fee", "<= 10%"],
  "dbc.pool": ["dbc pool", "this launch"],
  "hook.policy": ["guard policy", "matches cert"],
  "hook.metaList": ["hook account list", "canonical"],
  "fees.routing": ["fee routing", "fixed"],
  "batch.cap": ["batch cap", "in policy"],
  "batch.accounting": ["batch accounting", "balanced"],
  "batch.firstSwap": ["first trade", "the batch"],
  "damm.migration": ["graduation", "pending"],
  "damm.lock": ["lp position", "100% locked"],
  "damm.lpLocked": ["lp position", "100% locked"],
  "damm.pool": ["damm v2 pool", "from migration"],
  "damm.status": ["damm v2 pool", "enabled"],
  "damm.fee": ["pool fee tier", "as launched"],
  "meteora.programs": ["meteora programs", "reviewed"],
  "meteora.dbc": ["meteora dbc", "reviewed build"],
  "meteora.dammV2": ["meteora damm v2", "reviewed build"],
  "program.launchpad": ["launchpad program", "deployed"],
  "program.hook": ["guard hook program", "deployed"],
  "rpc.clock": ["rpc clock", "implausible"],
};

export function shortCheck(c: VerificationCheck, phase: LaunchPhase | null): [string, string] {
  const known = SHORT_CHECKS[c.id];
  let [label, value] = known ?? [
    c.label
      .replace(/\s*\((live|config)\)\s*$/i, "")
      .replace(/\s*\(.*\)\s*$/, "")
      .toLowerCase(),
    "ok",
  ];
  if ((c.id === "certificate.bit32" || c.id === "mint.transferHook") && /\brevoked\b/i.test(`${c.label} ${c.detail}`)) value = "revoked";
  if (c.id === "launch.phase" && phase) value = phase;
  if (c.status === "warn") value = "WARNING";
  if (c.status === "fail") value = "FAILED";
  return [label, value];
}


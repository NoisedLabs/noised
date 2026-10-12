/**
 * Independent re-checks of a launched mint from live chain data:
 * `checkQsl1` (the QSL-1 standard; on devnet the best outcome is
 * "candidate": levels are only given on mainnet with finalized programs) and
 * `verifyLaunch` (every launch check, the PQ origin, the metadata record and
 * the rules). Results go to the run's results.jsonl.
 */
import { check, log, sdk } from "./lib.mjs";

export async function verifyMint(ctx, label, mint, opts = {}) {
  const { conn } = ctx;
  const q = await sdk.checkQsl1(conn, mint, { commitment: "confirmed" });
  const badge = sdk.qslBadge(q);
  const failed = q.checks.filter((c) => c.status === "fail").map((c) => c.id);
  const prog = q.programmable;
  const progText = JSON.stringify({
    present: prog.present,
    verified: prog.verified,
    tag: badge.programmable,
    rules: prog.rules ? { verified: prog.rules.verified, explain: prog.rules.explain } : null,
    autopilot: prog.autopilot ? { address: prog.autopilot.address?.toBase58?.() } : null,
    componentChecks: prog.checks.map((c) => `${c.id}:${c.status}`),
    warnings: prog.warnings.map((w) => w.kind),
  });
  log(ctx, `${label}: checkQsl1 cluster=${q.cluster} level=${q.level} candidate=${q.candidate} wouldBe=${q.wouldBe} badge="${badge.title}" failing=[${failed.join(", ")}]`);
  log(ctx, `${label}: programmable=${progText}`);
  log(ctx, `${label}: QSL-1 reasons: ${q.reasons.join(" | ")}`);
  check(ctx, `${label}: checkQsl1 says candidate (devnet)`, q.candidate === true && q.level === 0, `cluster ${q.cluster}, level ${q.level}, wouldBe ${q.wouldBe}, badge "${badge.title}", blocking [${q.blocking.join(", ")}]`);
  if (opts.expectProgrammable) check(ctx, `${label}: programmable tag`, prog.present && badge.programmable !== null, `programmable present ${prog.present}, verified ${prog.verified}, tag ${JSON.stringify(badge.programmable)}`);

  const v = await sdk.verifyLaunch(conn, mint, { listOperators: false });
  const bad = v.checks.filter((c) => c.status === "fail");
  const warn = v.checks.filter((c) => c.status === "warn");
  log(ctx, `${label}: verifyLaunch overall=${v.overall} phase=${v.phase} checks=${v.checks.length} fail=[${bad.map((c) => `${c.id}: ${c.detail}`).join("; ")}] warn=[${warn.map((c) => c.id).join(", ")}] pqOrigin.verified=${v.pqOrigin?.verified} metadata.verified=${v.metadata?.verified} rules.verified=${v.rules?.verified}`);
  check(ctx, `${label}: verifyLaunch has no failing check`, bad.length === 0, `overall ${v.overall}; ${v.checks.length} checks, ${warn.length} warnings`);
  return { qsl: q, badge, verify: v };
}

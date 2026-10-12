/**
 * Verify a Noised launch from live chain data before trusting it
 * (read-only: it signs and sends nothing).
 *
 *   RPC_URL=https://api.mainnet-beta.solana.com MINT=<mint address> node examples/verify-mint.ts
 *
 * Exit code: 0 when nothing fails, 1 when a check fails or the mint is not a Noised launch.
 *
 * Every check is recomputed from live accounts; the on-chain certificate is
 * never trusted on its own. The token's description, icon and links are read
 * from its on-chain metadata record (found through the certificate, at the
 * address of the hash the creator's PQ identity signed); nothing is fetched
 * from a link. The report is only as honest as the RPC that served it: for
 * large decisions, run it against two independent providers.
 *
 * It then checks the mint against QSL-1, the quantum security layer's token
 * standard (`checkQsl1`), and prints the badge an app may show (`qslBadge`):
 * a level only on mainnet with finalized Noised programs, otherwise at most
 * "QSL-1 candidate: not final yet".
 */
import { PublicKey } from "@solana/web3.js";
import { checkQsl1, qslBadge, verifyLaunch, type QslResult, type VerificationReport } from "@noisedlabs/sdk";

import { connectionFromEnv, requireEnv, toHex } from "./shared.ts";

const MARK = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;

function print(report: VerificationReport): void {
  console.log(`Mint ${report.mint.toBase58()}: ${report.overall.toUpperCase()} (phase: ${report.phase ?? "unknown"})\n`);
  for (const c of report.checks) console.log(`[${MARK[c.status]}] ${c.label}\n       ${c.detail}`);

  const pq = report.pqOrigin;
  console.log("\nPost-quantum origin:");
  if (pq === null || !pq.verified) {
    // Never show an identity as proof of origin unless `verified` is true.
    console.log("  NOT PQ-attested (see the pq.origin check above).");
  } else {
    console.log(`  identity  ${toHex(pq.identityId)} (account ${pq.identity.toBase58()})`);
    console.log(`  leaf      ${pq.leaf} of 1,024, attested in slot ${pq.attestationSlot}`);
    console.log(`  window    ${new Date(Number(pq.window.notBefore) * 1000).toISOString()} .. ${new Date(Number(pq.window.notAfter) * 1000).toISOString()}`);
    console.log(`  record    ${pq.tokenMeta.toBase58()} (metadata hash ${toHex(pq.metadataHash)})`);
  }

  const m = report.metadata;
  console.log("\nToken metadata (on-chain record):");
  if (m === null || !m.verified || m.record === null) {
    // Show a description, icon or links only from a verified record.
    console.log("  not verified (see the metadata checks above): show the name and symbol only.");
  } else {
    console.log(`  name      ${m.record.name} (${m.record.symbol})`);
    const d = m.document;
    if (d === null || d.empty) console.log("  document  none");
    else if (!d.ok) console.log(`  document  not shown: ${d.problems.join("; ")}`);
    else {
      if (d.description !== null) console.log(`  about     ${d.description}`);
      if (d.icon !== null) console.log(`  icon      ${d.icon.width}x${d.icon.height} PNG, ${d.icon.png.length} bytes, inside the record`);
      // Links are text to show with their host spelled out, never to open automatically.
      for (const l of d.links) console.log(`  ${l.kind.padEnd(9)} ${l.url} (goes to ${l.host})`);
      for (const w of d.warnings) console.log(`  note      ${w}`);
    }
  }

  // Creator launch rules (P1c): signed by the creator's post-quantum identity and held by the transfer hook.
  console.log("\nLaunch rules:");
  if (report.rules === null) console.log("  unknown (no certificate)");
  else {
    if (report.rules.hash !== "0".repeat(64)) console.log(`  rules ${report.rules.hash}${report.rules.verified ? "" : " (NOT verified: see the checks above)"}`);
    for (const line of report.rules.explanation) console.log(`  ${line}`);
  }

  console.log("\nWho you still trust:");
  for (const t of report.trustedParties) console.log(`  - ${t.name}: ${t.note}`);
}

function printQsl(result: QslResult): void {
  const badge = qslBadge(result);
  console.log(`
QSL-1: ${badge.title} (mint ${badge.mint})${badge.showOnTradeScreen ? "" : " [developer view only on mainnet]"}`);
  for (const line of badge.lines) console.log(`  ${line}`);
  for (const c of result.checks) if (c.status !== "pass") console.log(`  [${c.status.toUpperCase()}] ${c.id} ${c.plain}`);
}

async function main(): Promise<void> {
  const conn = connectionFromEnv();
  const mint = new PublicKey(requireEnv("MINT"));
  const report = await verifyLaunch(conn, mint);
  print(report);
  printQsl(await checkQsl1(conn, mint));
  if (report.overall === "fail") process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

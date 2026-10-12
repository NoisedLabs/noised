/**
 * Re-verify launched mints from live chain data (read-only): `checkQsl1`
 * (QSL-1; "candidate" is the best outcome on devnet) and `verifyLaunch`.
 *
 *   NOISED_DEVNET_DIR=<state dir> node scripts/devnet/40-verify.mjs [mint ...]
 *
 * Without arguments: the mints recorded by the flows in that directory
 * (state-flow-a.json, state-flow-b.json).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { log, runMain, web3 } from "./lib.mjs";
import { verifyMint } from "./verify-steps.mjs";

await runMain("verify", async (ctx) => {
  let mints = process.argv.slice(2).map((m) => ({ label: m, mint: new web3.PublicKey(m) }));
  if (mints.length === 0) {
    for (const flow of ["flow-a", "flow-b"]) {
      const f = join(ctx.dir, `state-${flow}.json`);
      if (!existsSync(f)) continue;
      const s = JSON.parse(readFileSync(f, "utf8"));
      if (s.mint) mints.push({ label: flow, mint: new web3.PublicKey(s.mint) });
    }
  }
  if (mints.length === 0) throw new Error("no mint given and none recorded in this state directory");
  for (const m of mints) {
    log(ctx, `== ${m.label}: ${m.mint.toBase58()}`);
    await verifyMint(ctx, m.label, m.mint, { expectProgrammable: true });
  }
});

/**
 * A keeper that executes a launch's fair-open batch as soon as its commit
 * window closes. `execute_batch` is permissionless: anyone may send it, and
 * one buy of `min(total committed, batch cap)` is made for every committer at
 * the same price. If nobody executes it within its window, the batch expires
 * and every commit is refunded in full.
 *
 *   RPC_URL=... KEEPER_KEYPAIR=~/.config/solana/keeper.json LAUNCH=<launch address> \
 *   CU_PRICE_MICROLAMPORTS=50000 node examples/keeper-execute-batch.ts
 *
 * The keeper only pays the transaction fee. Anyone can contend the batch's
 * write locks during the window, so pay a priority fee. Send `execute_batch`
 * as a top-level instruction (as built here): the Launch Guard recognises
 * the batch buy from the instructions sysvar, and a CPI'd one fails.
 */
import { PublicKey } from "@solana/web3.js";
import { buildExecuteBatchTx, getLaunchFlowStatus } from "@noisedlabs/sdk";

import { computeUnitPriceFromEnv, connectionFromEnv, loadKeypair, requireEnv, simulateSignSend, sleep } from "./shared.ts";

const POLL_MS = 2_000;

async function main(): Promise<void> {
  const conn = connectionFromEnv();
  const keeper = loadKeypair(requireEnv("KEEPER_KEYPAIR"));
  const launch = new PublicKey(requireEnv("LAUNCH"));
  const computeUnitPrice = computeUnitPriceFromEnv();

  for (;;) {
    const s = await getLaunchFlowStatus(conn, launch);
    console.log(`[${s.step}] ${s.summary}`);
    switch (s.step) {
      case "execute": {
        try {
          const tx = await buildExecuteBatchTx(conn, keeper.publicKey, launch, { computeUnitPrice });
          await simulateSignSend(conn, tx, [keeper], "execute_batch");
        } catch (e) {
          // Another keeper may have executed it first, or the pool was traded before the batch
          // (PoolAlreadyTraded: the batch then expires and refunds in full). Re-read the status.
          console.warn(`execute_batch: ${e instanceof Error ? e.message : String(e)}`);
          await sleep(POLL_MS);
        }
        break;
      }
      case "commit": {
        // Sleep until the commit window closes (on the cluster clock), in short steps.
        const left = s.account === null ? 1n : s.account.commitEndTs - s.nowSecs;
        await sleep(Math.min(POLL_MS * 5, Math.max(500, Number(left) * 1_000)));
        break;
      }
      case "create":
      case "attest":
      case "wait-for-window":
      case "launch":
        await sleep(POLL_MS * 5);
        break;
      default:
        // claim, trading, window-missed: nothing left for this keeper.
        return;
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

/**
 * Commit SOL to a launch's fair-open batch with the payout going straight
 * into post-quantum custody: the tokens to your PQ vault of the launch's
 * mint, the unspent SOL (as wSOL) to your wSOL PQ vault. Then claim.
 *
 *   RPC_URL=... NOISED_CLUSTER=devnet COMMITTER_KEYPAIR=~/.config/solana/id.json \
 *   PQ_PHRASE_FILE=./pq-phrase.txt LAUNCH=<launch address> LAMPORTS=100000000 \
 *   node examples/commit-and-claim-into-vault.ts commit
 *
 *   RPC_URL=... COMMITTER_KEYPAIR=... LAUNCH=... node examples/commit-and-claim-into-vault.ts claim
 *   RPC_URL=... COMMITTER_KEYPAIR=... LAUNCH=... node examples/commit-and-claim-into-vault.ts status
 *
 * Optional: VAULT_ACCOUNT (default 0, the phrase's vault account number),
 * CU_PRICE_MICROLAMPORTS (priority fee: the commit window is contested).
 *
 * The payout owners are fixed by your FIRST commit and cannot change. Every
 * commit naming one vault is held to one wallet's batch cap together.
 * `claim` is permissionless: anyone (a keeper) may send it, and it always
 * pays the owners the first commit fixed.
 */
import { PublicKey } from "@solana/web3.js";
import {
  buildClaimTx,
  buildCommitTx,
  expectedBatchFill,
  fetchCommit,
  fetchLaunch,
  fetchVault,
  getLaunchFlowStatus,
  masterFromPhrase,
  prepareFeeVault,
  preparePqVault,
} from "@noisedlabs/sdk";

import { clusterFromEnv, computeUnitPriceFromEnv, connectionFromEnv, formatUnits, loadKeypair, optionalEnv, readSecretFile, requireEnv, simulateSignSend } from "./shared.ts";

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "status";
  const conn = connectionFromEnv();
  const committer = loadKeypair(requireEnv("COMMITTER_KEYPAIR"));
  const launch = new PublicKey(requireEnv("LAUNCH"));
  const computeUnitPrice = computeUnitPriceFromEnv();

  const l = await fetchLaunch(conn, launch);
  if (l === null) throw new Error(`no launch at ${launch.toBase58()}`);
  const status = await getLaunchFlowStatus(conn, launch, { owner: committer.publicKey });
  console.log(`[${status.step}] ${status.summary}`);

  if (mode === "commit") {
    if (status.step !== "commit") throw new Error("the commit window is not open");
    const lamports = BigInt(requireEnv("LAMPORTS"));
    const { cluster, allowLocalnet } = clusterFromEnv();
    const account = Number(optionalEnv("VAULT_ACCOUNT", "0"));

    // The phrase's vaults for the launch's mint and for wSOL (the SDK checks
    // the RPC serves `cluster` first). Only an OPENED vault can be a payout
    // owner: open them now if needed (you pay their rent).
    const master = masterFromPhrase(readSecretFile(requireEnv("PQ_PHRASE_FILE")));
    let tokenVault, refundVault;
    try {
      tokenVault = await preparePqVault(conn, { master, cluster, mint: l.baseMint, payer: committer.publicKey, account, allowLocalnet });
      refundVault = await prepareFeeVault(conn, { master, cluster, payer: committer.publicKey, account, allowLocalnet });
    } finally {
      master.fill(0);
    }
    if (tokenVault.openTx !== null) await simulateSignSend(conn, tokenVault.openTx, [committer], "open the token vault");
    if (refundVault.openTx !== null) await simulateSignSend(conn, refundVault.openTx, [committer], "open the wSOL vault");

    // Above the batch's total cap, every commit is filled pro rata and the rest refunded at claim.
    const existing = await fetchCommit(conn, launch, committer.publicKey);
    const fill = expectedBatchFill(l, lamports, existing?.amount ?? 0n);
    console.log(
      `your commit: ${formatUnits(fill.commit.amount, 9)} SOL; at most ${formatUnits(fill.commit.spent, 9)} SOL spent if the batch executes now (${fill.fillBps / 100}% fill), the rest refunded`,
    );

    const tx = await buildCommitTx(conn, committer.publicKey, launch, lamports, {
      tokenOwner: tokenVault.vault,
      refundOwner: refundVault.vault,
      computeUnitPrice,
    });
    await simulateSignSend(conn, tx, [committer], "commit");
    console.log(`tokens will be paid to ${tokenVault.tokenAccount.toBase58()} (vault ${tokenVault.vault.toBase58()})`);
    return;
  }

  if (mode === "claim") {
    if (status.step !== "claim") throw new Error("nothing to claim for this wallet now");
    const commit = status.commit!;
    // Permissionless: the payer only pays for missing token accounts; the payout goes to the commit's owners.
    const tx = await buildClaimTx(conn, committer.publicKey, launch, committer.publicKey, { computeUnitPrice });
    await simulateSignSend(conn, tx, [committer], "claim");
    for (const [what, owner] of [
      ["tokens", commit.tokenOwner],
      ["refund", commit.refundOwner],
    ] as const) {
      const vault = await fetchVault(conn, owner);
      console.log(vault === null ? `${what} paid to the wallet ${owner.toBase58()}` : `${what} vault ${owner.toBase58()} now holds ${vault.balance} base units`);
    }
    return;
  }

  if (status.commit !== null) {
    const c = status.commit;
    console.log(`your commit: ${formatUnits(c.amount, 9)} SOL, tokens to ${c.tokenOwner.toBase58()}, refund to ${c.refundOwner.toBase58()}, claimed: ${c.claimed}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

/**
 * Withdraw from a post-quantum (LM-OTS) vault, the safe way: never a second
 * signature with one key.
 *
 *   RPC_URL=... NOISED_CLUSTER=devnet WALLET_KEYPAIR=~/.config/solana/id.json \
 *   PQ_PHRASE_FILE=./pq-phrase.txt MINT=<mint> DESTINATION=<recipient wallet> AMOUNT=<base units> \
 *   node examples/vault-withdraw.ts [--confirm-recipient-warnings] [--confirm-mint-warnings] [--confirm-off-curve]
 *
 * Optional: VAULT_ACCOUNT (default 0), STATE_DIR (default ./.noised-withdraw),
 * CU_PRICE_MICROLAMPORTS (priority fee), IMPORT_LEDGER (a file another device
 * wrote with EXPORT_LEDGER: its signed vault-key records, imported before
 * anything is signed here), EXPORT_LEDGER (write this device's signed
 * records there afterwards, for the other device; records an older SDK
 * wrote without their key are completed first, so that they can travel).
 *
 * The rules this script follows (and why):
 * 1. Each vault key signs ONE message, ever. The vault-key ledger in
 *    STATE_DIR (one file per key, created exclusively) records the key's
 *    withdrawal BEFORE its signature exists and the signature before it is
 *    returned; a key holding a record never signs anything else. A re-run
 *    with the same request gets the identical recorded signature back; a
 *    re-run with another request re-broadcasts the recorded one instead.
 *    Keep STATE_DIR (and a backup of it). Two machines holding the phrase
 *    must share one ledger, or import each other's records before signing
 *    (IMPORT_LEDGER / EXPORT_LEDGER: authenticated, add-only; an import that
 *    reports keys the other machine could not export stops this script), or
 *    use different VAULT_ACCOUNTs.
 * 2. `prepareWithdrawal` also searches the vault's history: if the current
 *    key already signed something (even in a failed transaction), that
 *    withdrawal is recorded and returned for re-broadcast; nothing new is
 *    signed.
 * 3. The recipient is checked and confirmed BEFORE signing: `checkRecipient`
 *    runs first, refusals stop, and recipient warnings, mint warnings and the
 *    off-curve case each need their own flag above. The confirmation goes to
 *    `prepareWithdrawal` (`confirm`), which refuses to sign without it, and
 *    re-runs the check right before signing (anything new stops it).
 * 4. The SDK refuses to sign unless the RPC serves NOISED_CLUSTER (genesis
 *    hash).
 * 5. A throwaway fee payer pays: the wallet never appears next to the vault.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildFundFeePayerTx,
  buildRefundFeePayerTx,
  buildWithdrawTxWithFallback,
  checkRecipient,
  completeVaultKeyRecords,
  createVaultKeyLedger,
  deriveVaultKey,
  exportVaultKeyRecords,
  GENESIS_KEY_INDEX,
  importVaultKeyRecords,
  IncompleteSearchError,
  masterFromPhrase,
  prepareWithdrawal,
  RecipientConfirmationError,
  sendAndConfirm,
  vaultAddress,
  VaultKeyInUseError,
  type PendingWithdrawalContinuation,
  type PreparedWithdrawal,
  type RecipientConfirmation,
  type VaultKeyLedgerExport,
  type WithdrawTxArgs,
} from "@noisedlabs/sdk";

import {
  clusterFromEnv,
  computeUnitPriceFromEnv,
  connectionFromEnv,
  fileLeafLedgerStore,
  loadKeypair,
  optionalEnv,
  readSecretFile,
  replaceDurably,
  requireEnv,
  simulateSendV1,
  simulateSignSend,
} from "./shared.ts";

/** The withdrawal to broadcast: one the vault key already signed (found on chain), or the signed one (new or recorded). */
function toArgs(prepared: PreparedWithdrawal): WithdrawTxArgs {
  const p = prepared.pending;
  if (p !== null) {
    if (p.nextKey === null || !p.executable) throw new Error(`the vault's key already signed a withdrawal that cannot execute (${p.txSignature}): do not sign again`);
    console.warn(`the vault's current key already signed a withdrawal of ${p.maxAmount} to ${p.destinationOwner.toBase58()} (${p.txSignature}): re-broadcasting THAT one`);
    return { mint: p.mint, vault: p.vault, sequence: p.sequence, destinationOwner: p.destinationOwner, maxAmount: p.maxAmount, signature: p.signature, nextKey: p.nextKey, nextKeyId: p.nextKeyId };
  }
  if (prepared.signed === null) throw new Error("nothing was signed");
  if (prepared.signed.reused) console.log(`re-broadcasting the recorded withdrawal for sequence ${prepared.signed.args.sequence}`);
  return prepared.signed.args;
}

async function main(): Promise<void> {
  const conn = connectionFromEnv();
  const { cluster, allowLocalnet } = clusterFromEnv();
  const wallet = loadKeypair(requireEnv("WALLET_KEYPAIR"));
  const mint = new PublicKey(requireEnv("MINT"));
  const account = Number(optionalEnv("VAULT_ACCOUNT", "0"));
  const stateDir = optionalEnv("STATE_DIR", "./.noised-withdraw");
  mkdirSync(stateDir, { recursive: true });
  const feePayerFile = join(stateDir, "fee-payer.json");
  // 1. The durable one-signature-per-key records (an exclusive file create is the atomic add it needs).
  const ledger = createVaultKeyLedger(fileLeafLedgerStore(join(stateDir, "vault-key-ledger")));
  // Another device's records come in BEFORE anything is signed here (authenticated; nothing is written if one fails).
  const importFile = optionalEnv("IMPORT_LEDGER", "");
  if (importFile !== "") {
    const summary = await importVaultKeyRecords(ledger, JSON.parse(readFileSync(importFile, "utf8")) as VaultKeyLedgerExport);
    console.log(`imported vault-key records: ${summary.added} added, ${summary.merged} completed, ${summary.unchanged} already known`);
    if (summary.compromised.length > 0) console.warn(`keys that signed two different withdrawals: ${summary.compromised.join(", ")}: broadcast one of them now`);
    if (summary.conflicts.length > 0) console.warn(`keys the two devices gave to two withdrawals: ${summary.conflicts.join(", ")}`);
    // Keys the other device signed with but could not export (records of an older SDK without their key): they are
    // spent, and nothing here knows which withdrawal they signed. Never sign here until the other device sends them.
    if (summary.unverifiable.length > 0) {
      throw new Error(
        `the other device signed with ${summary.unverifiable.length} vault key(s) it could not export (${summary.unverifiable.join(", ")}): nothing was signed here. Run this script there once with EXPORT_LEDGER (it completes those records first), then import that file here.`,
      );
    }
  }
  const exportFile = optionalEnv("EXPORT_LEDGER", "");

  const destinationOwner = new PublicKey(requireEnv("DESTINATION"));
  const maxAmount = BigInt(requireEnv("AMOUNT"));
  const master = masterFromPhrase(readSecretFile(requireEnv("PQ_PHRASE_FILE")));
  let args: WithdrawTxArgs | null = null;
  try {
    // 3. The recipient, checked and confirmed before anything is signed (three separate confirmations).
    const genesis = deriveVaultKey(master, cluster, mint, account, GENESIS_KEY_INDEX);
    genesis.skSeed.fill(0);
    const check = await checkRecipient(conn, destinationOwner, mint, vaultAddress(mint, genesis.keyId), { wallet: wallet.publicKey });
    if (!check.ok) throw new Error(`refused recipient:\n${check.refusals.join("\n")}`);
    for (const w of check.recipientWarnings) console.warn(`recipient warning: ${w}`);
    for (const w of check.mintWarnings) console.warn(`mint warning: ${w}`);
    if (check.offCurveConfirmation !== null) console.warn(`off-curve recipient: ${check.offCurveConfirmation}`);
    const confirm: RecipientConfirmation = {
      recipient: check,
      acknowledged: {
        recipientWarnings: process.argv.includes("--confirm-recipient-warnings"),
        mintWarnings: process.argv.includes("--confirm-mint-warnings"),
        offCurveConfirmation: process.argv.includes("--confirm-off-curve"),
      },
    };

    // 2. Ledger, history search, then (only if the key never signed) one deterministic signature.
    let continueFrom: PendingWithdrawalContinuation | undefined;
    while (args === null) {
      try {
        const prepared = await prepareWithdrawal(conn, master, cluster, mint, account, { destinationOwner, maxAmount }, { ledger, confirm, allowLocalnet, continueFrom });
        args = toArgs(prepared);
      } catch (e) {
        // A long history is searched in pieces; there is no way to skip the search.
        if (e instanceof IncompleteSearchError && e.search.continuation !== null) {
          continueFrom = e.search.continuation;
          console.log(`history search: ${e.search.examined} transactions read so far, continuing`);
          continue;
        }
        // The key already belongs to another withdrawal: broadcast that one, never a second message.
        if (e instanceof VaultKeyInUseError && e.withdrawal !== null) {
          console.warn(`${e.message}\nre-broadcasting the recorded withdrawal of ${e.withdrawal.maxAmount} to ${e.withdrawal.destinationOwner.toBase58()}`);
          args = e.withdrawal;
          continue;
        }
        // Not confirmed (a missing flag), or the check changed since it was shown: nothing was signed or recorded.
        if (e instanceof RecipientConfirmationError) {
          throw new Error(`${e.message}\nRead the warnings above, then re-run with the matching --confirm-… flags only if you are sure.`);
        }
        throw e;
      }
    }
    // Records an older SDK wrote without their key cannot be exported: give them their key first (nothing is signed).
    if (exportFile !== "") {
      const completion = await completeVaultKeyRecords(ledger, master, cluster, mint, Math.min(account, 1_000));
      if (completion.completed.length > 0) console.log(`completed ${completion.completed.length} vault-key record(s) of an older SDK with their key`);
      if (completion.remaining.length > 0) console.warn(`signed records without their key that this phrase's accounts 0..=${account} of this mint do not hold: ${completion.remaining.join(", ")}`);
    }
  } finally {
    master.fill(0);
  }
  // Carry this device's signed records to the other device (it imports them before it signs).
  if (exportFile !== "") replaceDurably(exportFile, JSON.stringify(await exportVaultKeyRecords(ledger), null, 2));

  // 5. A throwaway fee payer, kept on disk until it is refunded.
  const feePayer = existsSync(feePayerFile) ? loadKeypair(feePayerFile) : Keypair.generate();
  if (!existsSync(feePayerFile)) {
    replaceDurably(feePayerFile, JSON.stringify(Array.from(feePayer.secretKey)));
    const fund = await buildFundFeePayerTx(conn, wallet.publicKey, feePayer.publicKey);
    await simulateSignSend(conn, fund, [wallet], "fund the throwaway fee payer");
  }

  // Withdraw + release in one v1 transaction when that works now, else the withdrawal alone. The builder
  // simulates (reveals) only a signature the ledger holds.
  const built = await buildWithdrawTxWithFallback(conn, feePayer, args, { ledger, computeUnitPrice: computeUnitPriceFromEnv() });
  if (!built.simulation.ok) throw new Error(`the withdrawal fails in simulation: ${built.simulation.error ?? "unknown error"} (re-run the same command later: the recorded signature stays valid)`);
  await simulateSendV1(conn, built.tx, built.lastValidBlockHeight, built.includesRelease ? "withdraw + release" : "withdraw");

  if (!built.includesRelease) {
    console.log(`the payout ${built.payout.toBase58()} is reserved but not delivered (${built.releaseError}); deliver it later with buildReleaseTx, or the recipient signs buildReleaseToTx`);
    return;
  }
  // Delivered: return what is left on the fee payer (the payout's rent came back to it).
  const refund = await buildRefundFeePayerTx(conn, feePayer, wallet.publicKey);
  await sendAndConfirm(conn, refund);
  renameSync(feePayerFile, `${feePayerFile}.${args.sequence}.done`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

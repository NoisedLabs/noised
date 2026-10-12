/** TEST ONLY: signed vault v4 withdrawals made outside any ledger (a test-local signer: the SDK exports none). */
import { Keypair, PublicKey } from "@solana/web3.js";

import { toHex } from "../../src/lib/format";
import { mockSignDeterministic } from "../../src/lib/mock/lmotsSigner";
import { deriveVaultKey, masterFromPhrase, vaultAddress, withdrawMessage, type Cluster } from "../../src/lib/noised";
import { encodeKey, type StoredWithdrawal } from "../../src/lib/storage";

export const TEST_PHRASE = "abandon ".repeat(23) + "art";

/** A withdrawal of vault account #0 of `TEST_PHRASE` for `mint`, signed by its key at `sequence`. */
export function signedRecord(
  opts: { sequence?: number; recipient?: PublicKey; maxAmount?: bigint; mint?: PublicKey; cluster?: Cluster; master?: Uint8Array } = {},
): StoredWithdrawal {
  const master = opts.master ?? masterFromPhrase(TEST_PHRASE);
  const cluster = opts.cluster ?? "devnet";
  const mint = opts.mint ?? Keypair.generate().publicKey;
  const sequence = opts.sequence ?? 0;
  const recipient = opts.recipient ?? Keypair.generate().publicKey;
  const maxAmount = opts.maxAmount ?? 42n;
  const genesis = deriveVaultKey(master, cluster, mint, 0, 0);
  const key = deriveVaultKey(master, cluster, mint, 0, sequence);
  const next = deriveVaultKey(master, cluster, mint, 0, sequence + 1);
  const vault = vaultAddress(mint, genesis.keyId);
  const msg = withdrawMessage(vault, mint, BigInt(sequence), recipient, maxAmount, next.keyId);
  const sig = mockSignDeterministic(key.skSeed, key.pk, msg);
  return {
    version: 4,
    mode: "live",
    cluster,
    vault: vault.toBase58(),
    mint: mint.toBase58(),
    account: 0,
    sequence: String(sequence),
    key: encodeKey(key.pk),
    nextKey: encodeKey(next.pk),
    destinationOwner: recipient.toBase58(),
    maxAmount: maxAmount.toString(),
    message: toHex(msg),
    signature: toHex(sig),
    source: "signed",
    feePayerSecret: toHex(Keypair.generate().secretKey),
    feePayerRefunded: false,
    status: "signed",
    lastIncludedRelease: null,
    lastTxSignature: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

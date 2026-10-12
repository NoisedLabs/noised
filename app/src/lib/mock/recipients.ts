/**
 * MOCK `checkTokenRecipient`: the SDK's check of who may receive a launch
 * payout (a commit's token or refund owner, a swap's recipient, a fee
 * recipient), with the same refusals, warnings and kinds, read from the
 * simulated chain. Paying ATA(owner, mint) works for any owner, so owners
 * that could never move the tokens are refused.
 */
import { associatedTokenAddress, KNOWN_ACCOUNTS, PROGRAM_IDS, type TokenRecipientCheck, type TokenRecipientKind } from "@noisedlabs/sdk";
import { PublicKey } from "@solana/web3.js";

import { accountAt, vaultMintAt } from "./accounts";
import type { MockState } from "./store";

export function tokenRecipientCheck(s: MockState, recipient: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TokenRecipientCheck {
  const ata = associatedTokenAddress(recipient, mint, tokenProgram);
  const refusals: string[] = [];
  const warnings: string[] = [];
  const done = (kind: TokenRecipientKind | null): TokenRecipientCheck => ({ ok: refusals.length === 0, kind: refusals.length === 0 ? kind : null, refusals, warnings, ata });
  if (recipient.equals(PublicKey.default)) {
    refusals.push("the all-zero address is nobody's");
    return done(null);
  }
  const acc = accountAt(s, recipient);
  if (acc !== null && acc.owner.equals(PROGRAM_IDS.vault)) {
    const other = vaultMintAt(s, recipient);
    if (other !== null && other.equals(mint)) return done("pq-vault");
    refusals.push(
      other === null
        ? "an account of the PQ vault program that is not a vault (a payout or an old vault version): nothing can ever move tokens sent to it"
        : `a PQ vault of another mint (${other.toBase58()}): a vault only releases its own mint, so these tokens would be stuck forever`,
    );
    return done(null);
  }
  if (acc !== null && (acc.owner.equals(KNOWN_ACCOUNTS.splToken) || acc.owner.equals(KNOWN_ACCOUNTS.token2022))) {
    refusals.push("a token account or mint is not a wallet: its own associated token account can never be moved");
    return done(null);
  }
  if (PublicKey.isOnCurve(recipient.toBytes())) {
    if (acc !== null && acc.executable) refusals.push("a program is not a wallet");
    return done("wallet");
  }
  if (acc === null) {
    refusals.push(
      "an off-curve address with no account: an unopened vault, a closed account or a mistyped program address. Nobody holds a key for it; open the vault first, or name a wallet",
    );
    return done(null);
  }
  if (acc.executable) {
    refusals.push("a program is not a wallet");
    return done(null);
  }
  warnings.push(
    `an off-curve account of ${acc.owner.equals(KNOWN_ACCOUNTS.system) ? "the system program (a program wallet, e.g. a multisig vault)" : `program ${acc.owner.toBase58()}`}: only that program can move what its token account receives`,
  );
  return done("program-account");
}

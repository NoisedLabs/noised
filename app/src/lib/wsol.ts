/**
 * What a transaction does with the wallet's wSOL account (its associated
 * token account for wrapped SOL), read from the BUILT transaction, so a
 * review never says more than the transaction does. The SDK's commit, claim
 * and DAMM v2 swap (and the simulated chain's) close that account only when
 * the same transaction created it, leaving an existing one, and any wSOL in
 * it, as it is; Meteora's DBC swap always closes it.
 */
import { Transaction, type PublicKey } from "@solana/web3.js";

import { associatedTokenAddress, KNOWN_ACCOUNTS, WSOL_MINT, type AnyTransaction } from "./noised";

/** SPL Token `CloseAccount` instruction tag. */
const CLOSE_ACCOUNT = 9;

/** True when `tx` closes `owner`'s wSOL account (SPL Token `CloseAccount` of ATA(owner, wSOL)). */
export function closesWsolAccount(tx: AnyTransaction, owner: PublicKey): boolean {
  if (!(tx instanceof Transaction)) return false;
  const account = associatedTokenAddress(owner, WSOL_MINT, KNOWN_ACCOUNTS.splToken);
  return tx.instructions.some((ix) => ix.programId.equals(KNOWN_ACCOUNTS.splToken) && ix.data[0] === CLOSE_ACCOUNT && ix.keys[0]?.pubkey.equals(account) === true);
}

/** The review line about the wSOL account a commit wraps its SOL into. */
export function commitWsolNote(closes: boolean): string {
  return closes
    ? "Creates a temporary wSOL account for the wrapped SOL and closes it again after the commit (its rent returns to you)."
    : "Wraps the SOL in your existing wSOL account and leaves that account open, with any wSOL it already holds.";
}

/** The review line about how a claim pays its SOL refund (`refund` already formatted). */
export function claimRefundNote(refund: string, closes: boolean): string {
  return closes
    ? `Refunds ${refund} of unspent SOL, as SOL: the claim creates a temporary wSOL account for it and closes it in the same transaction.`
    : `Refunds ${refund} of unspent SOL as wSOL into your wSOL account, which stays open (unwrap it from your wallet).`;
}

/** The review line about the wSOL account a swap pays from (buy) or into (sell). */
export function swapWsolNote(side: "buy" | "sell", closes: boolean): string {
  if (side === "buy") {
    return closes
      ? "Creates your token account if needed, then closes your wSOL account: any SOL left in it returns to you."
      : "Creates your token account if needed; your existing wSOL account stays open, with any wSOL it already holds.";
  }
  return closes
    ? "Unwraps the wSOL you receive back to SOL (your wSOL account is closed; any wSOL already in it returns to you as SOL too)."
    : "The SOL you receive stays wrapped, as wSOL in your existing wSOL account, which stays open.";
}

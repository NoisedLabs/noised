/**
 * The package's public `lmots` namespace: everything of `./lmots.ts` except
 * its two internal signing functions, `sign` and `signDeterministic`. An
 * LM-OTS key is a one-time key, so the only exported ways to sign with one
 * are the vault entry points `prepareWithdrawal` / `signWithdrawal`, which
 * reserve the key for the message in the durable vault-key ledger before any
 * signature exists and record the signature before returning it (and the
 * LMS leaf ledger, whose leaves are LM-OTS keys too). A raw signer with a
 * derived `skSeed` would bypass that ledger: two signatures of one key let
 * anyone forge a third.
 * `test/lmots.test.ts` checks that this list is `./lmots.ts` minus `sign`
 * and `signDeterministic`, and that no public path reaches either.
 */
export {
  candidatePublicKey,
  CHAIN_END,
  hmacSha256,
  ID_LEN,
  keyId,
  LS,
  N,
  P,
  PUBLIC_KEY_LEN,
  publicKey,
  publicKeyBytes,
  randomizer,
  RANDOMIZER_TAG,
  SIG_LEN,
  TYPECODE,
  verify,
  W,
} from "./lmots.js";
export type { LmotsPrivateKey, LmotsPublicKey } from "./lmots.js";

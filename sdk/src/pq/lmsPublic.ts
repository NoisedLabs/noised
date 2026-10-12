/**
 * The package's public `lms` namespace: everything of `./lms.ts` except its
 * two internal signing functions. An LMS leaf is a one-time key, so the only
 * exported ways to sign with a creator identity are the leaf ledger's
 * `reserveAndSign` / `signAtNextLeaf` (and `buildAttestLaunchTx` on top of
 * them), which reserve the leaf for the message durably before any signature
 * exists and record the signature before returning it.
 * `test/lms.test.ts` checks that this list is `./lms.ts` minus
 * `signLeafDeterministic` and `signLeafWithRandomizer` (and `leafProbeKey`,
 * the secret probe key's derivation from `SEED`: a key pair computes its own
 * probe, `LmsKeyPair.leafProbeStart`).
 */
export {
  D_INTR,
  D_LEAF,
  DOMAIN_IDENTITY_ID,
  encodeLmsPublicKey,
  identityId,
  LEAF_PROBE_KEY_TAG,
  LEAF_PROBE_V2_TAG,
  LMS_HEIGHT,
  LMS_LEAVES,
  LMS_OTS_TYPE,
  LMS_PUBLIC_KEY_LEN,
  LMS_SIGNATURE_LEN,
  LMS_SIGNATURE_OFFSETS,
  LMS_TREE_NODES,
  LMS_TYPE,
  legacyTreeCacheKey,
  LmsKeyPair,
  lmsKeyPair,
  lmsKeyPairFromTreeCache,
  lmsKeygen,
  lmsKeygenSync,
  lmsVerify,
  memoryTreeCacheStore,
  parseLmsPublicKey,
  parseLmsSignature,
  secretLeafProbeStart,
  TREE_CACHE_LEN,
  TREE_CACHE_TAG,
  treeCacheKey,
} from "./lms.js";
export type { LmsKeyPairOptions, LmsKeygenOptions, LmsPrivateKey, LmsPublicKey, LmsTreeCacheStore, ParsedLmsSignature } from "./lms.js";

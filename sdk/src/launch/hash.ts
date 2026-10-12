import { sha256 } from "@noble/hashes/sha2.js";

import { idlCodecs } from "../idl/index.js";
import type { LaunchParams } from "../types.js";

/** The certificate's `params_hash`: SHA-256 of the borsh-serialized `LaunchParams` (`pq_identity` included; = `serializeLaunchParams`). */
export function launchParamsHash(p: LaunchParams): Uint8Array {
  return sha256(idlCodecs().launchpad.encodeType("LaunchParams", p));
}

// The metadata hash the attestation signs is `metadataHashV2` (`../metadata/record.ts`): the hash of the
// on-chain metadata record (name, symbol, flags, uri, document), which also names the record's address.
// The version 1 hash over name, symbol and uri (`launchMetadataHash`) is retired with attestation message v1.

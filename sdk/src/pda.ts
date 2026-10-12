/**
 * Program-derived addresses (SPEC §1.1, §2, §3), seeds byte for byte as in
 * the programs (checked against the Rust sources and Rust-derived addresses
 * in `test/sources.test.ts` and `test/vault_vectors.test.ts`).
 */
import { PublicKey } from "@solana/web3.js";

import { compareBytes, isAllZero, u64le, utf8 } from "./codec/bytes.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS, SEEDS, WSOL_MINT } from "./constants.js";
import { identityId } from "./pq/lms.js";

function pda(seeds: Uint8Array[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

function seed32(name: string, b: Uint8Array): Uint8Array {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
  return b;
}

// ------------------------------------------------------------ launchpad ---

export interface LaunchPdas {
  protocol: PublicKey;
  launch: PublicKey;
  launchAuthority: PublicKey;
  batchAuthority: PublicKey;
  dbcConfig: PublicKey;
  hookAuthority: PublicKey;
}

export function protocolAddress(): PublicKey {
  return pda([utf8(SEEDS.protocol)], PROGRAM_IDS.launchpad);
}

/**
 * Launch PDA: `["launch", creator, launch_seed]`. A launch's address names
 * its creator, so nobody can take the address another creator's launch is
 * meant for (seed squatting).
 */
export function launchAddress(creator: PublicKey, launchSeed: Uint8Array): PublicKey {
  if (!(creator instanceof PublicKey)) throw new TypeError("creator must be a PublicKey");
  return pda([utf8(SEEDS.launch), creator.toBytes(), seed32("launch seed", launchSeed)], PROGRAM_IDS.launchpad);
}

export function hookAuthorityAddress(): PublicKey {
  return pda([utf8(SEEDS.hookAuthority)], PROGRAM_IDS.launchpad);
}

/** Every launchpad PDA of a launch, from its address. */
export function launchPdasFromLaunch(launch: PublicKey): LaunchPdas {
  const p = PROGRAM_IDS.launchpad;
  return {
    protocol: protocolAddress(),
    launch,
    launchAuthority: pda([utf8(SEEDS.authority), launch.toBytes()], p),
    batchAuthority: pda([utf8(SEEDS.batch), launch.toBytes()], p),
    dbcConfig: pda([utf8(SEEDS.dbcConfig), launch.toBytes()], p),
    hookAuthority: hookAuthorityAddress(),
  };
}

/** Every launchpad PDA of a launch, from its creator and 32-byte seed. */
export function launchPdas(creator: PublicKey, launchSeed: Uint8Array): LaunchPdas {
  return launchPdasFromLaunch(launchAddress(creator, launchSeed));
}

export function certificateAddress(baseMint: PublicKey): PublicKey {
  return pda([utf8(SEEDS.certificate), baseMint.toBytes()], PROGRAM_IDS.launchpad);
}

export function commitAddress(launch: PublicKey, owner: PublicKey): PublicKey {
  return pda([utf8(SEEDS.commit), launch.toBytes(), owner.toBytes()], PROGRAM_IDS.launchpad);
}

/** A launch's post-quantum attestation: `["attestation", launch]`. */
export function attestationAddress(launch: PublicKey): PublicKey {
  return pda([utf8(SEEDS.attestation), launch.toBytes()], PROGRAM_IDS.launchpad);
}

/**
 * What every commit naming the PQ vault `vault` as token owner committed to
 * `launch`, held to one wallet's batch cap: `["payout-vault", launch, vault]`.
 * `commit` takes it as its last account when the token owner is a vault.
 */
export function payoutVaultAddress(launch: PublicKey, vault: PublicKey): PublicKey {
  return pda([utf8(SEEDS.payoutVault), launch.toBytes(), vault.toBytes()], PROGRAM_IDS.launchpad);
}

/**
 * A launch's metadata record (`TokenMeta`): `["metadata", launch,
 * metadata_hash]`, where `metadata_hash` is `metadataHashV2` of the record's
 * content, so the address names exactly one content. `attest_launch` takes
 * the record its signed hash names, `launch` the one its attestation names
 * (the IDL carries no PDA for `attest_launch`'s account). Anyone may publish
 * other records under a launch: resolve a token's record only through its
 * attestation or certificate (`fetchTokenMetaForLaunch`,
 * `fetchTokenMetaForMint`), never by searching a launch's records.
 */
export function tokenMetaAddress(launch: PublicKey, metadataHash: Uint8Array): PublicKey {
  return tokenMetaPda(launch, metadataHash)[0];
}

/** `tokenMetaAddress` and its canonical bump (the one `publish_metadata` stores). */
export function tokenMetaPda(launch: PublicKey, metadataHash: Uint8Array): [PublicKey, number] {
  if (!(launch instanceof PublicKey)) throw new TypeError("launch must be a PublicKey");
  return PublicKey.findProgramAddressSync([utf8(SEEDS.metadata), launch.toBytes(), seed32("metadata hash", metadataHash)], PROGRAM_IDS.launchpad);
}

/**
 * A launch's creator rules record (`LaunchRules`): `["rules", launch,
 * rules_hash]`, where `rules_hash = SHA256("PHX-RULES-V1" || PXR1 bytes)`
 * (`rulesHash`), so the address names exactly one content. `attest_launch`
 * and `launch` take the record the signed (attested) hash names, or the
 * launchpad program id in its place for the zero hash (no rules). Resolve a
 * token's rules only through its attestation or certificate.
 */
export function launchRulesAddress(launch: PublicKey, rulesHash: Uint8Array): PublicKey {
  return launchRulesPda(launch, rulesHash)[0];
}

/** `launchRulesAddress` and its canonical bump (the one `publish_rules` stores). */
export function launchRulesPda(launch: PublicKey, rulesHash: Uint8Array): [PublicKey, number] {
  if (!(launch instanceof PublicKey)) throw new TypeError("launch must be a PublicKey");
  const h = seed32("rules hash", rulesHash);
  if (isAllZero(h)) throw new RangeError("the all-zero rules hash means no rules: there is no record (pass the launchpad program id in its place)");
  return PublicKey.findProgramAddressSync([utf8(SEEDS.launchRules), launch.toBytes(), h], PROGRAM_IDS.launchpad);
}

/**
 * The identity account of the LMS key that signs: `["identity",
 * SHA256(0x21 || lms_pk)]`. `attest_launch` takes this account for the key
 * it is sent (the IDL carries no PDA for it); a signature by another key
 * burns that key's leaf, never this one's.
 */
export function identityAddress(lmsPublicKey: Uint8Array): PublicKey {
  // `SHA256(0x21 || lms_pk)` (`noised_lmots::identity_id`): the one implementation, in ./pq/lms.ts.
  return identityAddressFromId(identityId(lmsPublicKey));
}

/** The identity account of an identity id (`pq_identity`, 32 bytes, never all zero). */
export function identityAddressFromId(identityId: Uint8Array): PublicKey {
  const id = seed32("identity id", identityId);
  if (isAllZero(id)) throw new RangeError("the all-zero identity id has no key behind it");
  return pda([utf8(SEEDS.identity), id], PROGRAM_IDS.launchpad);
}

// ----------------------------------------------------------------- hook ---

export function hookPolicyAddress(mint: PublicKey): PublicKey {
  return pda([utf8(SEEDS.hookPolicy), mint.toBytes()], PROGRAM_IDS.hook);
}

export function extraAccountMetaListAddress(mint: PublicKey): PublicKey {
  return pda([utf8(SEEDS.extraAccountMetas), mint.toBytes()], PROGRAM_IDS.hook);
}

// ----------------------------------------------------------- Meteora DBC ---

/** DBC pool PDA: `["pool", config, max(base, quote), min(base, quote)]` (byte order). */
export function dbcPoolAddress(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey = WSOL_MINT): PublicKey {
  const a = baseMint.toBytes();
  const b = quoteMint.toBytes();
  const [first, second] = compareBytes(a, b) > 0 ? [a, b] : [b, a];
  return pda([utf8(SEEDS.dbcPool), config.toBytes(), first, second], PROGRAM_IDS.dbc);
}

/** DBC pool vault for `mint`: `["token_vault", mint, pool]`. */
export function dbcTokenVaultAddress(mint: PublicKey, pool: PublicKey): PublicKey {
  return pda([utf8(SEEDS.dbcTokenVault), mint.toBytes(), pool.toBytes()], PROGRAM_IDS.dbc);
}

// ------------------------------------------------------- Meteora DAMM v2 ---

/** DAMM v2 pool PDA: `["pool", config, max(a, b), min(a, b)]`. */
export function dammV2PoolAddress(config: PublicKey, mintA: PublicKey, mintB: PublicKey): PublicKey {
  const a = mintA.toBytes();
  const b = mintB.toBytes();
  const [first, second] = compareBytes(a, b) > 0 ? [a, b] : [b, a];
  return pda([utf8(SEEDS.dammPool), config.toBytes(), first, second], PROGRAM_IDS.dammV2);
}

export function dammV2PositionAddress(positionNftMint: PublicKey): PublicKey {
  return pda([utf8(SEEDS.dammPosition), positionNftMint.toBytes()], PROGRAM_IDS.dammV2);
}

export function dammV2PositionNftAccountAddress(positionNftMint: PublicKey): PublicKey {
  return pda([utf8(SEEDS.dammPositionNftAccount), positionNftMint.toBytes()], PROGRAM_IDS.dammV2);
}

// ---------------------------------------------------------------- vault ---

/**
 * PQ vault PDA: `["vault", mint, genesis_key_id]`. The address commits to
 * the key that opened the vault and never changes: later keys rotate in place.
 */
export function vaultAddress(mint: PublicKey, genesisKeyId: Uint8Array): PublicKey {
  return pda([utf8(SEEDS.vault), mint.toBytes(), seed32("genesis key id", genesisKeyId)], PROGRAM_IDS.vault);
}

/** Payout PDA of a vault's withdrawal at `sequence`: `["payout", vault, u64le(sequence)]`. */
export function payoutAddress(vault: PublicKey, sequence: bigint): PublicKey {
  return pda([utf8(SEEDS.payout), vault.toBytes(), u64le(sequence)], PROGRAM_IDS.vault);
}

// --------------------------------------------------------------- shield ---

export interface ShieldAddresses {
  shield: PublicKey;
  authority: PublicKey;
  zMint: PublicKey;
  escrow: PublicKey;
}

/**
 * Shield PDAs. `baseTokenProgram` (default Token-2022, which every Noised
 * launch uses) only affects the escrow ATA; pass SPL Token for SPL mints.
 */
export function shieldAddresses(baseMint: PublicKey, baseTokenProgram: PublicKey = KNOWN_ACCOUNTS.token2022): ShieldAddresses {
  const p = PROGRAM_IDS.shield;
  const authority = pda([utf8(SEEDS.shieldAuthority), baseMint.toBytes()], p);
  return {
    shield: pda([utf8(SEEDS.shield), baseMint.toBytes()], p),
    authority,
    zMint: pda([utf8(SEEDS.zMint), baseMint.toBytes()], p),
    escrow: associatedTokenAddress(authority, baseMint, baseTokenProgram),
  };
}

// ------------------------------------------------------------ autopilot ---

/** `["autopilot", launch]` (autopilot program): the launch's autopilot (`init_autopilot`, anyone, once). */
export function autopilotAddress(launch: PublicKey): PublicKey {
  return pda([utf8(SEEDS.autopilot), launch.toBytes()], PROGRAM_IDS.autopilot);
}

/**
 * `["treasury", launch]` (autopilot program): the treasury authority, which
 * owns the treasury's wSOL and token accounts. Derivable before the launch
 * exists, so a creator can name it as a fee recipient in `create_launch`
 * (`distribute` then pays its wSOL account).
 */
export function autopilotTreasuryAddress(launch: PublicKey): PublicKey {
  return pda([utf8(SEEDS.autopilotTreasury), launch.toBytes()], PROGRAM_IDS.autopilot);
}

/** `["graph", launch, graph_hash]` (autopilot program): a published PXG1 graph, at the address its content hashes to. */
export function graphRecordAddress(launch: PublicKey, graphHash: Uint8Array): PublicKey {
  return pda([utf8(SEEDS.graphRecord), launch.toBytes(), seed32("graphHash", graphHash)], PROGRAM_IDS.autopilot);
}

/**
 * `["auth", launch, [kind], payload_hash]` (launchpad): the post-quantum
 * authorization the autopilot reads for `activate` (kind 1), `freeze` (2)
 * and `revoke_operator` (3). Written by the launchpad's `pq_authorize`
 * (`buildPqAuthorizeTx`).
 */
export function authorizationAddress(launch: PublicKey, kind: number, payloadHash: Uint8Array): PublicKey {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) throw new RangeError("kind must be a byte");
  return pda([utf8(SEEDS.authorization), launch.toBytes(), Uint8Array.of(kind), seed32("payloadHash", payloadHash)], PROGRAM_IDS.launchpad);
}

export interface AutopilotPdas {
  autopilot: PublicKey;
  treasury: PublicKey;
  /** The treasury's wSOL account (SPL Token ATA of the treasury). */
  treasuryWsol: PublicKey;
  /** The treasury's token account (Token-2022 ATA of the treasury), once the mint is known. */
  treasuryToken: PublicKey | null;
}

/** Every address of a launch's autopilot (the token account only with the mint). */
export function autopilotPdas(launch: PublicKey, mint?: PublicKey | null): AutopilotPdas {
  const treasury = autopilotTreasuryAddress(launch);
  return {
    autopilot: autopilotAddress(launch),
    treasury,
    treasuryWsol: wsolAta(treasury),
    treasuryToken: mint === undefined || mint === null ? null : associatedTokenAddress(treasury, mint, KNOWN_ACCOUNTS.token2022),
  };
}

// ------------------------------------------------------------------ ATA ---

/** Canonical associated token account; the owner may be a PDA (off curve). */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = KNOWN_ACCOUNTS.token2022): PublicKey {
  if (!tokenProgram.equals(KNOWN_ACCOUNTS.token2022) && !tokenProgram.equals(KNOWN_ACCOUNTS.splToken)) {
    throw new Error(`not a token program: ${tokenProgram.toBase58()}`);
  }
  return pda([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], KNOWN_ACCOUNTS.associatedToken);
}

/** wSOL ATA (SPL Token). */
export function wsolAta(owner: PublicKey): PublicKey {
  return associatedTokenAddress(owner, WSOL_MINT, KNOWN_ACCOUNTS.splToken);
}

/** The ProgramData account of an upgradeable (loader-v3) program. */
export function programDataAddress(program: PublicKey): PublicKey {
  return pda([program.toBytes()], KNOWN_ACCOUNTS.bpfLoaderUpgradeable);
}

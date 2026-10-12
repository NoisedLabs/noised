/**
 * Launchpad account decoding and reads: `Launch`, `Commit`, `Certificate`,
 * `Protocol`, the post-quantum `Identity` and `Attestation`, `PayoutVault`,
 * plus the live market snapshot a `Launch` cannot tell (DBC pool reserves,
 * curve completion, migration).
 */
import { PublicKey, type Connection } from "@solana/web3.js";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual, isAllZero, isUint } from "../codec/bytes.js";
import type { EnumValue } from "../codec/idl.js";
import {
  AUTHORIZATION,
  CERTIFICATE,
  certificateChecksComplete,
  DAMM_V2_MIGRATION_CONFIGS,
  HOOK_POLICY,
  KNOWN_ACCOUNTS,
  LAUNCH_RULES,
  PQ_IDENTITY,
  PROGRAM_IDS,
  SEEDS,
  WSOL_MINT,
} from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { DBC_MIGRATION_PROGRESS, decodeDbcTransferHookPool, type DbcPoolState } from "../meteora/state.js";
import {
  attestationAddress,
  authorizationAddress,
  certificateAddress,
  commitAddress,
  dammV2PoolAddress,
  hookPolicyAddress,
  identityAddress,
  identityAddressFromId,
  launchRulesAddress,
  launchRulesPda,
  payoutVaultAddress,
  protocolAddress,
} from "../pda.js";
import { identityId as lmsIdentityId } from "../pq/lms.js";
import { rulesHash as rulesHashOf } from "../programmable/hash.js";
import { getAccount, getAccounts, ownedBy, type RawAccount } from "../rpc/fetch.js";
import { MintParseError, parseMint, tokenMetadataOf, transferHookOf } from "../token/mint.js";
import type {
  AttestationAccount,
  AuthorizationAccount,
  CertificateAccount,
  CommitAccount,
  FeeRecipient,
  HookPolicyAccount,
  IdentityAccount,
  LaunchAccount,
  LaunchRulesAccount,
  LaunchState,
  MarketSnapshot,
  PayoutVaultAccount,
  ProtocolAccount,
} from "../types.js";

type Decoded<T> = Omit<T, "publicKey">;

export function decodeLaunch(publicKey: PublicKey, data: Uint8Array): LaunchAccount {
  const raw = idlCodecs().launchpad.decodeAccount<Omit<LaunchState, "status"> & { status: EnumValue }>("Launch", data);
  const status = raw.status.kind === "Configured" ? "configured" : raw.status.kind === "Live" ? "live" : null;
  if (status === null) throw new Error(`unknown launch status ${raw.status.kind}`);
  return { ...raw, status, publicKey };
}

export function decodeCommit(publicKey: PublicKey, data: Uint8Array): CommitAccount {
  return { ...idlCodecs().launchpad.decodeAccount<Decoded<CommitAccount>>("Commit", data), publicKey };
}

/**
 * Decode a `Certificate`: version 4 (519 bytes, `rules_hash` at 487..519) or
 * version 3 (487 bytes, written before creator rules existed: `rulesHash`
 * all zero). Any other version or length is refused. Test its checks with
 * `certificateChecksComplete` (`(checks & 4095) === 4095`): a version-4
 * certificate with rules also carries `RULES_BOUND` (8,191).
 */
export function decodeCertificate(publicKey: PublicKey, data: Uint8Array): CertificateAccount {
  const codec = idlCodecs().launchpad;
  if (!codec.hasDiscriminator("Certificate", data)) throw new Error("not a Certificate account (discriminator mismatch)");
  const version = data[8];
  if (version === CERTIFICATE.VERSION && data.length === CERTIFICATE.ACCOUNT_LEN) {
    return { ...codec.decodeAccount<Decoded<CertificateAccount>>("Certificate", data), publicKey };
  }
  if (version === CERTIFICATE.V3_VERSION && data.length === CERTIFICATE.V3_ACCOUNT_LEN) {
    // Version 3 is version 4 without the appended `rules_hash`: decode it with a zero hash (no rules).
    const padded = new Uint8Array(CERTIFICATE.ACCOUNT_LEN);
    padded.set(data);
    return { ...codec.decodeAccount<Decoded<CertificateAccount>>("Certificate", padded), publicKey };
  }
  throw new Error(`certificate has version ${String(version)} and ${data.length} bytes; this SDK reads version 4 (${CERTIFICATE.ACCOUNT_LEN} bytes) and version 3 (${CERTIFICATE.V3_ACCOUNT_LEN} bytes)`);
}

export function decodeProtocol(publicKey: PublicKey, data: Uint8Array): ProtocolAccount {
  return { ...idlCodecs().launchpad.decodeAccount<Decoded<ProtocolAccount>>("Protocol", data), publicKey };
}

/** Decode a `PayoutVault` account (82 bytes: discriminator, version, bump, launch, vault, committed u64 at 74..82). */
export function decodePayoutVault(publicKey: PublicKey, data: Uint8Array): PayoutVaultAccount {
  return { ...idlCodecs().launchpad.decodeAccount<Decoded<PayoutVaultAccount>>("PayoutVault", data), publicKey };
}

/**
 * Decode an `Identity` account (196 bytes): LMS public key at 10..66, the
 * used-leaf bitmap at 66..194 (least significant bit first), `used_count`
 * u16 at 194..196. Refuses an account that is not at the identity PDA of
 * its own key, or whose count disagrees with its bitmap.
 */
export function decodeIdentity(publicKey: PublicKey, data: Uint8Array): IdentityAccount {
  const raw = idlCodecs().launchpad.decodeAccount<{ version: number; bump: number; publicKey: Uint8Array; used: Uint8Array; usedCount: number }>("Identity", data);
  // attest_launch writes version 1 with a key it verified a signature under (types LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4): nothing else is an identity.
  if (raw.version !== PQ_IDENTITY.IDENTITY_VERSION) throw new Error(`identity account has version ${raw.version}; this SDK reads version ${PQ_IDENTITY.IDENTITY_VERSION}`);
  const types = new DataView(raw.publicKey.buffer, raw.publicKey.byteOffset, raw.publicKey.byteLength);
  if (raw.publicKey.length !== PQ_IDENTITY.PUBLIC_KEY_LEN || types.getUint32(0, false) !== PQ_IDENTITY.LMS_TYPE || types.getUint32(4, false) !== PQ_IDENTITY.LMOTS_TYPE) {
    throw new Error(`identity account's LMS key does not have the typecodes ${PQ_IDENTITY.LMS_TYPE} / ${PQ_IDENTITY.LMOTS_TYPE} (LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4)`);
  }
  const identityId = lmsIdentityId(raw.publicKey); // the one implementation (lms.identityId, as pda.ts)
  if (!identityAddress(raw.publicKey).equals(publicKey)) throw new Error("identity account is not the PDA of its own LMS key");
  let bits = 0;
  for (const b of raw.used) for (let x = b; x !== 0; x &= x - 1) bits++;
  if (bits !== raw.usedCount) throw new Error(`identity account counts ${raw.usedCount} used leaves but its bitmap has ${bits}`);
  return { publicKey, version: raw.version, bump: raw.bump, lmsPublicKey: raw.publicKey, identityId, used: raw.used, usedCount: raw.usedCount };
}

/** Whether leaf `q` (0..1023) of an identity has signed a message that landed (`used[q >> 3] & (1 << (q & 7))`). */
export function identityLeafUsed(identity: Pick<IdentityAccount, "used">, q: number): boolean {
  if (!isUint(q, PQ_IDENTITY.LEAVES - 1)) throw new RangeError(`leaf must be 0..${PQ_IDENTITY.LEAVES - 1}`);
  return ((identity.used[q >> 3] ?? 0) & (1 << (q & 7))) !== 0;
}

/**
 * Decode an `Attestation` account (version 3, 2,708 bytes): launch 10..42,
 * pq_identity 42..74, leaf 74..76, metadata_hash 76..108, rules_hash
 * 108..140, message_hash 140..172, slot 172..180, not_before 180..188,
 * not_after 188..196, signature length 196..200, signature 200..2,708.
 * Version 0 is an empty attestation (a landing that only burned its leaf):
 * `attested` false. An attestation of another version (a version 2 written
 * before P1c) decodes as not attested: `launch` refuses it.
 */
export function decodeAttestation(publicKey: PublicKey, data: Uint8Array): AttestationAccount {
  const codec = idlCodecs().launchpad;
  if (!codec.hasDiscriminator("Attestation", data)) throw new Error("not an Attestation account (discriminator mismatch)");
  if (data[8] !== 0 && data[8] !== PQ_IDENTITY.ATTESTATION_VERSION) {
    // Another layout (version 2: no rules hash): never usable by this program's `launch`.
    return {
      publicKey,
      version: data[8]!,
      bump: data[9]!,
      attested: false,
      launch: PublicKey.default,
      pqIdentity: new Uint8Array(32),
      leaf: 0,
      metadataHash: new Uint8Array(32),
      rulesHash: new Uint8Array(32),
      messageHash: new Uint8Array(32),
      slot: 0n,
      notBefore: 0n,
      notAfter: 0n,
      signature: new Uint8Array(0),
    };
  }
  const raw = codec.decodeAccount<Omit<AttestationAccount, "publicKey" | "attested">>("Attestation", data);
  const attested = raw.version === PQ_IDENTITY.ATTESTATION_VERSION && !raw.launch.equals(PublicKey.default);
  if (attested) {
    if (!attestationAddress(raw.launch).equals(publicKey)) throw new Error("attestation account is not the PDA of the launch it names");
    if (raw.signature.length !== PQ_IDENTITY.SIGNATURE_LEN) throw new Error(`attestation signature is ${raw.signature.length} bytes, expected ${PQ_IDENTITY.SIGNATURE_LEN}`);
  }
  return { ...raw, publicKey, attested };
}

/**
 * Decode a `LaunchRules` record (`78 + len` bytes): version 1, the bytes
 * hashing to the stored `rules_hash` (`SHA256("PHX-RULES-V1" || bytes)`),
 * at `["rules", launch, rules_hash]` with its canonical bump, and exactly
 * `78 + len` bytes long. Refuses anything else.
 */
export function decodeLaunchRules(publicKey: PublicKey, data: Uint8Array): LaunchRulesAccount {
  const raw = idlCodecs().launchpad.decodeAccount<Omit<LaunchRulesAccount, "publicKey">>("LaunchRules", data);
  if (raw.version !== LAUNCH_RULES.VERSION) throw new Error(`rules record has version ${raw.version}; this SDK reads version ${LAUNCH_RULES.VERSION}`);
  if (data.length !== LAUNCH_RULES.FIXED_LEN + raw.bytes.length) throw new Error(`rules record is ${data.length} bytes, expected ${LAUNCH_RULES.FIXED_LEN + raw.bytes.length}`);
  if (!bytesEqual(rulesHashOf(raw.bytes), raw.rulesHash)) throw new Error("rules record's bytes do not hash to its stored rules hash");
  const [address, bump] = launchRulesPda(raw.launch, raw.rulesHash);
  if (!address.equals(publicKey)) throw new Error("rules record is not at the address of its launch and hash");
  if (bump !== raw.bump) throw new Error("rules record does not store its address's canonical bump");
  return { ...raw, publicKey };
}

/**
 * The rules record `rulesHash` names for `launch` (null if nobody published
 * it, or for the all-zero hash: no rules). `commitment` defaults to
 * `confirmed`. Resolve a launch's rules through its attestation or
 * certificate, never by searching for records of a launch.
 */
export async function fetchLaunchRules(conn: Connection, launch: PublicKey, rulesHash: Uint8Array, opts: { commitment?: "confirmed" | "finalized" } = {}): Promise<LaunchRulesAccount | null> {
  if (!(rulesHash instanceof Uint8Array) || rulesHash.length !== 32) throw new RangeError("rulesHash must be 32 bytes");
  if (isAllZero(rulesHash)) return null;
  const address = launchRulesAddress(launch, rulesHash);
  const acc = ownedBy(await getAccount(conn, address, opts.commitment ?? "confirmed"), PROGRAM_IDS.launchpad, "LaunchRules");
  if (acc === null) return null;
  const r = decodeLaunchRules(address, acc.data);
  if (!r.launch.equals(launch) || !bytesEqual(r.rulesHash, rulesHash)) throw new Error("rules record belongs to another launch or hash");
  return r;
}

/**
 * Decode an `Authorization` (`pq_authorize`, 2,669 bytes): launch 10, pq_identity
 * 42, kind 74, payload_hash 75, message_hash 107, unix_time 139, slot 147,
 * leaf 155, signature length 157, signature 161. Version 0 is an empty
 * account (a landing that only burned its leaf): `authorized` false. An
 * authorized account must be at `["auth", launch, [kind], payload_hash]`
 * with its stored bump and hold a full signature.
 */
export function decodeAuthorization(publicKey: PublicKey, data: Uint8Array): AuthorizationAccount {
  const raw = idlCodecs().launchpad.decodeAccount<Omit<AuthorizationAccount, "publicKey" | "authorized">>("Authorization", data);
  const authorized = raw.version === AUTHORIZATION.VERSION && !raw.launch.equals(PublicKey.default);
  if (raw.version !== 0 && raw.version !== AUTHORIZATION.VERSION) throw new Error(`authorization has version ${raw.version}; this SDK reads version ${AUTHORIZATION.VERSION}`);
  if (authorized) {
    if (data.length !== AUTHORIZATION.ACCOUNT_LEN) throw new Error(`authorization is ${data.length} bytes, expected ${AUTHORIZATION.ACCOUNT_LEN}`);
    if (raw.signature.length !== PQ_IDENTITY.SIGNATURE_LEN) throw new Error(`authorization signature is ${raw.signature.length} bytes, expected ${PQ_IDENTITY.SIGNATURE_LEN}`);
    let expected: PublicKey;
    try {
      expected = PublicKey.createProgramAddressSync(
        [new TextEncoder().encode(SEEDS.authorization), raw.launch.toBytes(), Uint8Array.of(raw.kind), raw.payloadHash, Uint8Array.of(raw.bump)],
        PROGRAM_IDS.launchpad,
      );
    } catch {
      throw new Error("authorization's stored bump does not give a program address");
    }
    if (!expected.equals(publicKey)) throw new Error("authorization is not at the address of its launch, kind and payload hash");
  }
  return { ...raw, publicKey, authorized };
}

/** The authorization at `["auth", launch, [kind], payloadHash]` (null if none landed). Check `authorized`. */
export async function fetchAuthorization(conn: Connection, launch: PublicKey, kind: number, payloadHash: Uint8Array): Promise<AuthorizationAccount | null> {
  const address = authorizationAddress(launch, kind, payloadHash);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.launchpad, "Authorization");
  if (acc === null) return null;
  const a = decodeAuthorization(address, acc.data);
  if (a.authorized && (!a.launch.equals(launch) || a.kind !== kind || !bytesEqual(a.payloadHash, payloadHash))) throw new Error("authorization belongs to another launch, kind or payload");
  return a;
}

/**
 * Decode a Launch Guard policy (`HookPolicy` version 2: the fixed fields,
 * then the creator rules, u32 length at 275 and bytes from 279; exactly
 * `279 + len` bytes). Refuses another version or length.
 */
export function decodeHookPolicy(publicKey: PublicKey, data: Uint8Array): HookPolicyAccount {
  const raw = idlCodecs().hook.decodeAccount<Omit<HookPolicyAccount, "publicKey">>("HookPolicy", data);
  if (raw.version !== HOOK_POLICY.VERSION) throw new Error(`hook policy has version ${raw.version}; this SDK reads version ${HOOK_POLICY.VERSION}`);
  if (data.length !== HOOK_POLICY.BASE_LEN + raw.rules.length) throw new Error(`hook policy is ${data.length} bytes, expected ${HOOK_POLICY.BASE_LEN + raw.rules.length}`);
  return { ...raw, publicKey };
}

/** The Launch Guard policy of `mint` (null if none: not a Noised launch, or not live yet). */
export async function fetchHookPolicy(conn: Connection, mint: PublicKey): Promise<HookPolicyAccount | null> {
  const address = hookPolicyAddress(mint);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.hook, "HookPolicy");
  if (acc === null) return null;
  const p = decodeHookPolicy(address, acc.data);
  if (!p.mint.equals(mint)) throw new Error("the Launch Guard policy belongs to another mint");
  return p;
}

/** The recipients a launch actually stores (the first `recipientCount` slots). */
export function activeRecipients(launch: Pick<LaunchState, "recipients" | "recipientCount">): FeeRecipient[] {
  return launch.recipients.slice(0, launch.recipientCount);
}

export function launchAccountSize(): number {
  return idlCodecs().launchpad.accountSize("Launch");
}

export async function fetchProtocol(conn: Connection): Promise<ProtocolAccount | null> {
  const address = protocolAddress();
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.launchpad, "Protocol");
  return acc === null ? null : decodeProtocol(address, acc.data);
}

export async function fetchCertificate(conn: Connection, mint: PublicKey): Promise<CertificateAccount | null> {
  const address = certificateAddress(mint);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.launchpad, "Certificate");
  return acc === null ? null : decodeCertificate(address, acc.data);
}

/**
 * The attestation of `launch` (null if none landed yet). Check `attested`:
 * an empty attestation (version 0) means a signature only burned its leaf
 * and `launch` will refuse it. Before showing it as proof of origin,
 * re-verify its signature and compare `messageHash` with the message.
 */
export async function fetchAttestation(conn: Connection, launch: PublicKey): Promise<AttestationAccount | null> {
  const address = attestationAddress(launch);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.launchpad, "Attestation");
  if (acc === null) return null;
  const a = decodeAttestation(address, acc.data);
  if (a.attested && !a.launch.equals(launch)) throw new Error("attestation account belongs to another launch");
  return a;
}

/**
 * An identity account, by its 56-byte LMS public key or its 32-byte id
 * (`pq_identity`); null if none of its signatures landed yet (no leaf used).
 */
export async function fetchIdentity(conn: Connection, lmsPublicKeyOrId: Uint8Array): Promise<IdentityAccount | null> {
  let address: PublicKey;
  if (lmsPublicKeyOrId.length === PQ_IDENTITY.PUBLIC_KEY_LEN) address = identityAddress(lmsPublicKeyOrId);
  else if (lmsPublicKeyOrId.length === 32) address = identityAddressFromId(lmsPublicKeyOrId);
  else throw new RangeError(`pass a ${PQ_IDENTITY.PUBLIC_KEY_LEN}-byte LMS public key or a 32-byte identity id`);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.launchpad, "Identity");
  if (acc === null) return null;
  const identity = decodeIdentity(address, acc.data);
  const asked = lmsPublicKeyOrId.length === 32 ? identity.identityId : identity.lmsPublicKey;
  if (!bytesEqual(asked, lmsPublicKeyOrId)) throw new Error("identity account holds another key");
  return identity;
}

/**
 * The `PayoutVault` record of `vault` in `launch` (null before the first
 * commit naming it). While `batchWalletCap` is non-zero, `batchWalletCap -
 * committed` is what can still be committed for that vault, by anyone.
 */
export async function fetchPayoutVault(conn: Connection, launch: PublicKey, vault: PublicKey): Promise<PayoutVaultAccount | null> {
  const address = payoutVaultAddress(launch, vault);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.launchpad, "PayoutVault");
  if (acc === null) return null;
  const record = decodePayoutVault(address, acc.data);
  if (!record.launch.equals(launch) || !record.vault.equals(vault)) throw new Error("payout-vault record belongs to another launch or vault");
  return record;
}

export async function fetchCommit(conn: Connection, launch: PublicKey, owner: PublicKey): Promise<CommitAccount | null> {
  const address = commitAddress(launch, owner);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.launchpad, "Commit");
  if (acc === null) return null;
  const commit = decodeCommit(address, acc.data);
  if (!commit.launch.equals(launch) || !commit.owner.equals(owner)) throw new Error("commit account does not belong to this launch/owner");
  return commit;
}

/** Curve completion and migration flags from a DBC pool state and its threshold. */
export function curveStatus(pool: DbcPoolState, migrationQuoteThreshold: bigint): { curveComplete: boolean; migrated: boolean } {
  const migrated = pool.isMigrated !== 0 || pool.migrationProgress === DBC_MIGRATION_PROGRESS.CREATED_POOL;
  const curveComplete = migrated || pool.migrationProgress >= DBC_MIGRATION_PROGRESS.POST_BONDING_CURVE || pool.quoteReserve >= migrationQuoteThreshold;
  return { curveComplete, migrated };
}

/** The canonical DAMM v2 pool a DBC migration creates for this launch (fixed fee option config). */
export function canonicalDammPool(baseMint: PublicKey, migrationFeeOption: number): PublicKey | null {
  const config = DAMM_V2_MIGRATION_CONFIGS[migrationFeeOption];
  return config === undefined ? null : dammV2PoolAddress(config, baseMint, WSOL_MINT);
}

function buildMarket(
  launch: LaunchAccount,
  certificate: RawAccount | null,
  pool: RawAccount | null,
  mint: RawAccount | null,
  dammPool: RawAccount | null,
): MarketSnapshot | undefined {
  if (launch.status !== "live" || pool === null || mint === null) return undefined;
  const poolOwned = ownedBy(pool, PROGRAM_IDS.dbc, "DBC pool");
  if (poolOwned === null) return undefined;
  const state = decodeDbcTransferHookPool(poolOwned.data).poolState;
  let parsed;
  try {
    parsed = parseMint(mint.owner, mint.data);
  } catch (e) {
    if (e instanceof MintParseError) return undefined;
    throw e;
  }
  let meta = { name: "", symbol: "", uri: "" };
  try {
    const m = tokenMetadataOf(parsed);
    if (m !== null) meta = { name: m.name, symbol: m.symbol, uri: m.uri };
  } catch {
    // Display-only fields; verifyLaunch reports malformed metadata.
  }
  const cert = certificate === null ? null : decodeCertificate(certificate.address, ownedBy(certificate, PROGRAM_IDS.launchpad, "Certificate")!.data);
  const hook = transferHookOf(parsed);
  const { curveComplete, migrated } = curveStatus(state, launch.migrationQuoteThreshold);
  const damm = dammPool !== null && dammPool.owner.equals(PROGRAM_IDS.dammV2) && dammPool.data.length > 0 ? dammPool.address : null;
  return {
    name: meta.name,
    symbol: meta.symbol,
    uri: meta.uri,
    initialSupply: cert?.initialSupply ?? 0n,
    supply: parsed.supply,
    quoteReserve: state.quoteReserve,
    baseReserve: state.baseReserve,
    sqrtPrice: state.sqrtPrice,
    curveComplete,
    migrated,
    dammPool: migrated ? damm : null,
    hookActive: hook !== null && hook.programId !== null,
  };
}

/** Fetch and decode one launch, with its market snapshot once it is live. */
export async function fetchLaunch(conn: Connection, launch: PublicKey): Promise<LaunchAccount | null> {
  const acc = ownedBy(await getAccount(conn, launch), PROGRAM_IDS.launchpad, "Launch");
  if (acc === null) return null;
  const l = decodeLaunch(launch, acc.data);
  if (l.status !== "live") return l;
  const damm = canonicalDammPool(l.baseMint, l.migrationFeeOption);
  const [cert, pool, mint, dammPool] = await getAccounts(conn, [certificateAddress(l.baseMint), l.pool, l.baseMint, damm ?? KNOWN_ACCOUNTS.system]);
  const market = buildMarket(l, cert ?? null, pool ?? null, mint ?? null, damm === null ? null : (dammPool ?? null));
  return market === undefined ? l : { ...l, market };
}

/** The launch that certified `mint` (via its certificate), or null if `mint` is not a Noised launch. */
export async function fetchLaunchByMint(conn: Connection, mint: PublicKey): Promise<LaunchAccount | null> {
  const cert = await fetchCertificate(conn, mint);
  if (cert === null) return null;
  if (!cert.baseMint.equals(mint)) throw new Error("certificate does not belong to this mint");
  const l = await fetchLaunch(conn, cert.launch);
  if (l !== null && !l.baseMint.equals(mint)) throw new Error("launch referenced by the certificate has a different mint");
  return l;
}

/** Every launch of the launchpad (one `getProgramAccounts`), with market snapshots for live ones. */
export async function listLaunches(conn: Connection): Promise<LaunchAccount[]> {
  const codec = idlCodecs().launchpad;
  const disc = codec.accountDiscriminator("Launch");
  const accounts = await conn.getProgramAccounts(PROGRAM_IDS.launchpad, {
    commitment: "confirmed",
    filters: [{ dataSize: launchAccountSize() }, { memcmp: { offset: 0, bytes: encodeBase58(disc) } }],
  });
  const launches = accounts
    .map((a) => decodeLaunch(a.pubkey, new Uint8Array(a.account.data.buffer, a.account.data.byteOffset, a.account.data.byteLength)))
    .sort((x, y) => (x.launchTs === y.launchTs ? x.publicKey.toBase58().localeCompare(y.publicKey.toBase58()) : x.launchTs > y.launchTs ? -1 : 1));
  const live = launches.filter((l) => l.status === "live");
  const keys: PublicKey[] = [];
  for (const l of live) {
    keys.push(certificateAddress(l.baseMint), l.pool, l.baseMint, canonicalDammPool(l.baseMint, l.migrationFeeOption) ?? KNOWN_ACCOUNTS.system);
  }
  const fetched = await getAccounts(conn, keys);
  const markets = new Map<string, MarketSnapshot>();
  live.forEach((l, i) => {
    const [c, p, m, d] = fetched.slice(4 * i, 4 * i + 4);
    try {
      const market = buildMarket(l, c ?? null, p ?? null, m ?? null, d ?? null);
      if (market !== undefined) markets.set(l.publicKey.toBase58(), market);
    } catch {
      // A malformed account must not hide every other launch; verifyLaunch reports it.
    }
  });
  return launches.map((l) => {
    const market = markets.get(l.publicKey.toBase58());
    return market === undefined ? l : { ...l, market };
  });
}

/**
 * True if every check bit `launch` requires is set (SPEC §1.5):
 * `(checks & 4095) === 4095`. A certificate with creator rules also carries
 * the informational `RULES_BOUND` (8,191), which this accepts.
 */
export function certificateComplete(cert: Pick<CertificateAccount, "checks">): boolean {
  return certificateChecksComplete(cert.checks);
}

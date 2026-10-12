/**
 * The post-quantum origin of a launch, re-verified off-chain (PQ v2, A17,
 * with the on-chain metadata record and, since P1c, the creator rules).
 *
 * `launch` goes live only with an attestation: an LMS signature, by the
 * identity the launch names (`pq_identity`, inside `params_hash`), over
 *
 * ```text
 * "PHX-ATTEST-V3" || launchpad || launch || params_hash || creator
 *     || metadata_hash || rules_hash || i64le(not_before) || i64le(not_after)   221 bytes
 * ```
 *
 * where `metadata_hash = metadataHashV2(record)` names the token's metadata
 * record `["metadata", launch, metadata_hash]` and `rules_hash` the creator
 * rules record `["rules", launch, rules_hash]` (all zero: no rules). This
 * module does not take the program's (or the certificate's) word for it. It
 * reads the records the attestation names and recomputes their hashes,
 * rebuilds the 221 bytes from on-chain data alone (the Launch account's
 * address, `params_hash` and creator, those hashes and the attested window),
 * requires them to hash to the stored `message_hash`, and re-verifies the
 * stored signature against the LMS public key held by the identity account
 * `["identity", pq_identity]` (RFC 8554, `../pq/lms.ts`), at the recorded
 * leaf, which the identity's bitmap must mark as used. The signed rules must
 * be valid for the launch's guard; they are explained in plain English
 * (`explainRules`). After launch, the certificate's PQ fields, its
 * `metadata` and its `rules_hash` must equal the attestation's, the launch
 * must have run inside the window and the mint must hold exactly the
 * record's name, symbol and derived uri.
 *
 * Rules: no attestation, an empty one (version 0: a valid signature that
 * only burned its leaf), one of another version (a version 2, message v2,
 * written before P1c), a missing record or any mismatch means the launch is
 * NOT PQ-attested, a hard failure.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey, type Connection } from "@solana/web3.js";

import { bytesEqual, isAllZero, toHex } from "../codec/bytes.js";
import { POLICY, PQ_IDENTITY, PROGRAM_IDS } from "../constants.js";
import { decodeAttestation, decodeIdentity, decodeLaunch, decodeLaunchRules, identityLeafUsed } from "../launch/accounts.js";
import { decodeTokenMeta, tokenUriBytes, type TokenMetaAccount } from "../metadata/record.js";
import { attestationAddress, identityAddressFromId, launchRulesAddress, tokenMetaAddress } from "../pda.js";
import { attestationMessage } from "../pq/identity.js";
import { lmsVerify } from "../pq/lms.js";
import { verifyRules } from "../programmable/rules/codec.js";
import { explainRules } from "../programmable/rules/explain.js";
import { formatDurationLong } from "../programmable/units.js";
import { getAccounts, type RawAccount } from "../rpc/fetch.js";
import type { AttestationAccount, AttestedRules, CertificateAccount, IdentityAccount, LaunchAccount, LaunchRulesAccount, PqOrigin } from "../types.js";

/** The one explanation line of a launch without creator rules. */
export const NO_LAUNCH_RULES = "No launch rules: the creator set none, so only the standard launch protections apply.";

/**
 * Plain-English lines for a launch's rule bytes (`explainRules`, one line
 * per rule then what always holds), after verifying them for the launch's
 * guard as `publish_rules` and the Launch Guard did (the 72-hour maximum
 * when the launch is unknown). Empty bytes: `[NO_LAUNCH_RULES]`. Never
 * throws: rules that are not valid give no lines and a plain problem.
 */
export function explainLaunchRules(bytes: Uint8Array, launch: Pick<LaunchAccount, "guardSecs" | "tokenDecimal"> | null): { explanation: string[]; problem: string | null } {
  if (bytes.length === 0) return { explanation: [NO_LAUNCH_RULES], problem: null };
  const guard = launch === null ? null : launch.guardSecs;
  try {
    const v = verifyRules(bytes, guard === null ? {} : { guardSecs: guard });
    if (!v.ok) {
      const forGuard = guard === null ? "the longest launch guard (72 hours)" : `this launch's ${formatDurationLong(guard)} launch guard`;
      return { explanation: [], problem: `the launch rules are not valid for ${forGuard} (${v.message})` };
    }
    const explanation = explainRules(bytes, guard === null || launch === null ? {} : { guardSecs: guard, tokenDecimals: launch.tokenDecimal });
    return { explanation, problem: null };
  } catch (e) {
    return { explanation: [], problem: `the launch rules cannot be read (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** Name, symbol and uri exactly as the mint's TokenMetadata stores them (raw bytes). */
export interface OnChainMetadata {
  name: Uint8Array;
  symbol: Uint8Array;
  uri: Uint8Array;
  /** Bytes after the uri (the additional-metadata vector): `launch` leaves it empty (`u32le(0)`). */
  additional: Uint8Array;
}

/**
 * The raw name, symbol and uri bytes of a TokenMetadata extension value
 * (update authority 32, mint 32, then three u32le-length-prefixed fields and
 * the additional metadata). Raw bytes, not decoded text: a decoder may drop
 * a leading BOM or replace bytes, and the comparison must cover exactly what
 * is stored. Throws when truncated.
 */
export function tokenMetadataFields(extension: Uint8Array): OnChainMetadata {
  const view = new DataView(extension.buffer, extension.byteOffset, extension.byteLength);
  let off = 64;
  const field = (what: string): Uint8Array => {
    if (off + 4 > extension.length) throw new Error(`TokenMetadata ${what} is truncated`);
    const n = view.getUint32(off, true);
    off += 4;
    if (off + n > extension.length) throw new Error(`TokenMetadata ${what} is truncated`);
    const b = extension.slice(off, off + n);
    off += n;
    return b;
  };
  if (extension.length < 64) throw new Error("TokenMetadata is truncated");
  const name = field("name");
  const symbol = field("symbol");
  const uri = field("uri");
  return { name, symbol, uri, additional: extension.slice(off) };
}

/** What the attestation checks read (before or after launch). */
interface AttestationInputs {
  readonly launchAddress: PublicKey;
  /** The Launch account (its `params_hash`, creator and `pq_identity`); null if unreadable. */
  readonly launch: LaunchAccount | null;
  /** `params_hash` and creator to rebuild the message from when the launch is unreadable (the certificate's). */
  readonly fallback: { readonly paramsHash: Uint8Array; readonly creator: PublicKey } | null;
  /** The identity the attestation must be by (the launch's or the certificate's `pq_identity`). */
  readonly expectedIdentity: Uint8Array | null;
  readonly attestation: RawAccount | null;
  /** The account at `identityAddressFromId(attestation.pqIdentity)`. */
  readonly identity: RawAccount | null;
  /** The account at `tokenMetaAddress(launch, attestation.metadataHash)`. */
  readonly tokenMeta: RawAccount | null;
  /** The account at `launchRulesAddress(launch, attestation.rulesHash)` (null: none; unused for the zero hash). */
  readonly rules: RawAccount | null;
}

interface AttestationCheck {
  readonly attestation: AttestationAccount | null;
  readonly origin: PqOrigin | null;
  readonly record: TokenMetaAccount | null;
  readonly rulesRecord: LaunchRulesAccount | null;
  readonly message: Uint8Array | null;
  readonly problems: string[];
}

/** The attestation, its identity, its records and its signature, from fetched accounts (pure). */
function checkAttestation(i: AttestationInputs): AttestationCheck {
  const attAddr = attestationAddress(i.launchAddress);
  const acc = i.attestation;
  const none = (why: string, attestation: AttestationAccount | null = null): AttestationCheck => ({ attestation, origin: null, record: null, rulesRecord: null, message: null, problems: [why] });
  if (acc === null || (acc.data.length === 0 && !acc.owner.equals(PROGRAM_IDS.launchpad))) {
    return none(`no attestation account at ${attAddr.toBase58()}: this launch is not PQ-attested`);
  }
  if (!acc.owner.equals(PROGRAM_IDS.launchpad)) return none(`the attestation address ${attAddr.toBase58()} is owned by ${acc.owner.toBase58()}, not the launchpad: not PQ-attested`);
  let a: AttestationAccount;
  try {
    a = decodeAttestation(attAddr, acc.data);
  } catch (e) {
    return none(`the attestation account cannot be decoded (${e instanceof Error ? e.message : String(e)}): not PQ-attested`);
  }
  if (!a.attested) {
    if (a.version !== 0 && a.version !== PQ_IDENTITY.ATTESTATION_VERSION) {
      return none(`the attestation at ${attAddr.toBase58()} has version ${a.version}, which the launchpad no longer accepts (it signs version 3, which covers the launch rules); not PQ-attested`, a);
    }
    return none(`the attestation at ${attAddr.toBase58()} is empty (version ${a.version}): signatures only burned their leaves, none attested this launch; not PQ-attested`, a);
  }

  const problems: string[] = [];
  const need = (cond: boolean, why: string): void => {
    if (!cond) problems.push(why);
  };
  // Implied by the decoder (the account sits at the PDA of the launch it names, fetched at this launch's PDA); kept as defense in depth.
  need(a.launch.equals(i.launchAddress), "the attestation names another launch");
  need(i.expectedIdentity !== null && !isAllZero(i.expectedIdentity), "no identity is named for this launch");
  if (i.expectedIdentity !== null) need(bytesEqual(a.pqIdentity, i.expectedIdentity), "the attestation's identity is not the launch's pq_identity");
  need(i.launch !== null, "the Launch account is unreadable: its pq_identity, params_hash and creator cannot be checked");
  if (i.launch !== null) need(bytesEqual(i.launch.pqIdentity, a.pqIdentity), "the attestation's identity is not the launch's pq_identity");

  // The identity: its account holds the LMS public key; its id must be the attested one and its bitmap must mark the leaf.
  let identityAddr = PublicKey.default;
  let identity: IdentityAccount | null = null;
  try {
    identityAddr = identityAddressFromId(a.pqIdentity);
    const ia = i.identity;
    if (ia === null || ia.data.length === 0) problems.push(`no identity account at ${identityAddr.toBase58()}: the identity's public key cannot be read`);
    else if (!ia.owner.equals(PROGRAM_IDS.launchpad)) problems.push(`the identity account ${identityAddr.toBase58()} is not owned by the launchpad`);
    else if (!ia.address.equals(identityAddr)) problems.push("the identity account read is not the attested identity's");
    else identity = decodeIdentity(identityAddr, ia.data);
  } catch (e) {
    problems.push(`the identity account is invalid (${e instanceof Error ? e.message : String(e)})`);
  }
  if (identity !== null) {
    // Implied by the address checks above (the account is the PDA of its own key's id); kept as defense in depth.
    need(bytesEqual(identity.identityId, a.pqIdentity), "the identity account holds another key");
    need(identityLeafUsed(identity, a.leaf), `the identity's bitmap does not mark leaf ${a.leaf} as used`);
  }

  // The metadata record the signed hash names: it must exist, and its content must hash to that hash.
  const recordAddr = tokenMetaAddress(i.launchAddress, a.metadataHash);
  let record: TokenMetaAccount | null = null;
  const ra = i.tokenMeta;
  if (ra === null || ra.data.length === 0) problems.push(`no metadata record at ${recordAddr.toBase58()}: the attested metadata cannot be read`);
  else if (!ra.owner.equals(PROGRAM_IDS.launchpad)) problems.push(`the metadata record ${recordAddr.toBase58()} is not owned by the launchpad`);
  else if (!ra.address.equals(recordAddr)) problems.push("the metadata record read is not the attested one");
  else {
    try {
      record = decodeTokenMeta(recordAddr, ra.data);
      need(record.launch.equals(i.launchAddress), "the metadata record belongs to another launch");
      need(bytesEqual(record.metadataHash, a.metadataHash), "the metadata record is not the one the identity signed");
    } catch (e) {
      problems.push(`the metadata record is invalid (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // The creator rules the signed hash names (none for the zero hash): their record must exist and hash to it, and
  // the rules must be valid for the launch's guard.
  const rulesAddr = isAllZero(a.rulesHash) ? null : launchRulesAddress(i.launchAddress, a.rulesHash);
  let rulesRecord: LaunchRulesAccount | null = null;
  if (rulesAddr !== null) {
    const ra = i.rules;
    if (ra === null || ra.data.length === 0) problems.push(`the launch rules the identity signed are not published at ${rulesAddr.toBase58()}: they cannot be read`);
    else if (!ra.owner.equals(PROGRAM_IDS.launchpad)) problems.push(`the launch rules record ${rulesAddr.toBase58()} is not owned by the launchpad`);
    else if (!ra.address.equals(rulesAddr)) problems.push("the launch rules record read is not the signed one");
    else {
      try {
        rulesRecord = decodeLaunchRules(rulesAddr, ra.data);
        need(rulesRecord.launch.equals(i.launchAddress), "the launch rules record belongs to another launch");
        need(bytesEqual(rulesRecord.rulesHash, a.rulesHash), "the launch rules record is not the one the identity signed");
      } catch (e) {
        problems.push(`the launch rules record is invalid (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  const explained = rulesAddr === null ? explainLaunchRules(new Uint8Array(0), i.launch) : rulesRecord === null ? null : explainLaunchRules(rulesRecord.bytes, i.launch);
  if (explained !== null && explained.problem !== null) problems.push(explained.problem);
  const rules: AttestedRules = {
    hash: toHex(a.rulesHash),
    address: rulesAddr,
    bytes: rulesRecord?.bytes ?? new Uint8Array(0),
    explanation: explained?.explanation ?? [],
  };

  // The message, from on-chain data only.
  let message: Uint8Array | null = null;
  const source = i.launch ?? i.fallback;
  if (source === null) problems.push("neither the launch nor its certificate can be read: the signed message cannot be rebuilt");
  else {
    message = attestationMessage({
      programId: PROGRAM_IDS.launchpad,
      launch: i.launchAddress,
      paramsHash: source.paramsHash,
      creator: source.creator,
      metadataHash: a.metadataHash,
      rulesHash: a.rulesHash,
      notBefore: a.notBefore,
      notAfter: a.notAfter,
    });
    need(bytesEqual(sha256(message), a.messageHash), "the stored message hash is not the hash of the message rebuilt from on-chain data");
  }
  const signatureValid = message !== null && identity !== null && lmsVerify(identity.lmsPublicKey, message, a.signature) === a.leaf;
  need(signatureValid, message === null || identity === null ? "the signature could not be checked" : `the LMS signature does not verify at leaf ${a.leaf} over this launch's message`);
  const len = a.notAfter - a.notBefore;
  need(len >= BigInt(POLICY.MIN_LAUNCH_WINDOW_SECS) && len <= BigInt(POLICY.MAX_LAUNCH_WINDOW_SECS), `the attested window lasts ${len} s (allowed ${POLICY.MIN_LAUNCH_WINDOW_SECS}..=${POLICY.MAX_LAUNCH_WINDOW_SECS})`);

  const origin: PqOrigin = {
    attestation: attAddr,
    identity: identityAddr,
    identityId: a.pqIdentity,
    lmsPublicKey: identity?.lmsPublicKey ?? null,
    leaf: a.leaf,
    attestationSlot: a.slot,
    messageHash: a.messageHash,
    window: { notBefore: a.notBefore, notAfter: a.notAfter },
    metadataHash: a.metadataHash,
    tokenMeta: recordAddr,
    rules,
    signatureValid,
    verified: false,
  };
  return { attestation: a, origin, record, rulesRecord, message, problems };
}

/** Everything `checkPqOrigin` reads, as fetched from the chain. */
export interface PqOriginInputs {
  /** The launch's certificate (`launch`, `paramsHash`, `creator`, `launchedAt`, `metadata` and the PQ fields). */
  certificate: CertificateAccount;
  /** The Launch account (its `params_hash`, creator and `pq_identity` build the message); null if unreadable. */
  launch: LaunchAccount | null;
  /** The account at `attestationAddress(certificate.launch)` (null: none). */
  attestation: RawAccount | null;
  /** The account at `identityAddressFromId(certificate.pqIdentity)` (null: none). */
  identity: RawAccount | null;
  /** The account at `certificate.metadata`, the attested record (null: none). */
  tokenMeta: RawAccount | null;
  /** The mint's on-chain name, symbol and uri (null: unreadable). */
  metadata: OnChainMetadata | null;
  /**
   * The account at `launchRulesAddress(certificate.launch, rulesHash)` for
   * the attestation's `rulesHash`: the creator rules the identity signed
   * (null or omitted: none). Needed only when that hash is not all zero.
   */
  rules?: RawAccount | null;
}

export interface PqOriginResult {
  /** The origin to report; null when there is no attested attestation to show. */
  origin: PqOrigin | null;
  /** Why the launch is not PQ-attested (empty: it is). */
  problems: string[];
  /** The 221-byte message v3 rebuilt from on-chain data (null when it could not be rebuilt). */
  message: Uint8Array | null;
  /** The attested metadata record (null when missing or invalid). */
  record: TokenMetaAccount | null;
  /** The attested creator rules record (null: no rules, or the record is missing or invalid). */
  rulesRecord: LaunchRulesAccount | null;
  /** The decoded attestation (null: none or undecodable; an empty or retired one has `attested` false). */
  attestation: AttestationAccount | null;
}

/**
 * Re-verify a launch's post-quantum origin from fetched accounts (pure: no
 * RPC). `origin.verified` is true only when `problems` is empty.
 */
export function checkPqOrigin(i: PqOriginInputs): PqOriginResult {
  const c = i.certificate;
  const r = checkAttestation({
    launchAddress: c.launch,
    launch: i.launch,
    fallback: { paramsHash: c.paramsHash, creator: c.creator },
    expectedIdentity: c.pqIdentity,
    attestation: i.attestation,
    identity: i.identity,
    tokenMeta: i.tokenMeta,
    rules: i.rules ?? null,
  });
  const a = r.attestation;
  if (r.origin === null || a === null) return { origin: null, problems: r.problems, message: null, record: null, rulesRecord: null, attestation: a };
  const problems = [...r.problems];
  const need = (cond: boolean, why: string): void => {
    if (!cond) problems.push(why);
  };
  need(a.leaf === c.pqLeaf, `the certificate records leaf ${c.pqLeaf}, the attestation leaf ${a.leaf}`);
  need(a.slot === c.attestedSlot, `the certificate records attestation slot ${c.attestedSlot}, the attestation slot ${a.slot}`);
  need(c.metadata.equals(r.origin.tokenMeta), `the certificate names the metadata record ${c.metadata.toBase58()}, not the attested ${r.origin.tokenMeta.toBase58()}`);
  // A version-3 certificate has no rules hash (decoded as all zero): it matches an attestation that signed no rules.
  const certRules = c.rulesHash instanceof Uint8Array ? c.rulesHash : new Uint8Array(32);
  need(
    bytesEqual(certRules, a.rulesHash),
    isAllZero(a.rulesHash)
      ? "the certificate records launch rules, but the identity signed none"
      : isAllZero(certRules)
        ? "the identity signed launch rules, but the certificate records none"
        : "the certificate records other launch rules than the ones the identity signed",
  );
  // The mint holds exactly the record's name, symbol and derived uri, and no additional metadata.
  if (i.metadata === null) problems.push("the mint's metadata is unreadable: it cannot be compared with the attested record");
  else if (r.record !== null) {
    const m = i.metadata;
    const rec = r.record.record;
    need(bytesEqual(m.name, rec.name) && bytesEqual(m.symbol, rec.symbol), "the mint's name or symbol is not the attested record's");
    need(bytesEqual(m.uri, tokenUriBytes(rec)), "the mint's uri is not the one derived from the attested record");
    need(m.additional.length === 4 && isAllZero(m.additional), "the mint carries additional metadata the record does not");
  }
  need(c.launchedAt >= a.notBefore && c.launchedAt <= a.notAfter, `the launch ran at ${c.launchedAt}, outside the attested window ${a.notBefore}..=${a.notAfter}`);
  return { origin: { ...r.origin, verified: problems.length === 0 }, problems, message: r.message, record: r.record, rulesRecord: r.rulesRecord, attestation: a };
}

/** `verifyAttestation`'s result. */
export interface AttestationVerification {
  /** Every check passed: show the origin and the record as signed by the launch's identity. */
  readonly verified: boolean;
  /** Why not (empty when verified). */
  readonly problems: string[];
  readonly launch: LaunchAccount | null;
  /** The re-verified origin (null without an attested attestation). */
  readonly origin: PqOrigin | null;
  /** The record the attestation signed (null when missing or invalid). */
  readonly tokenMeta: TokenMetaAccount | null;
  /** The creator rules record the attestation signed (null: it signed none, or the record is missing or invalid). `origin.rules` explains them. */
  readonly launchRules: LaunchRulesAccount | null;
}

/**
 * Before launch (and after): re-verify a launch's attestation from live
 * accounts, the way `verifyLaunch` does after launch but without a
 * certificate: the attestation is attested (version 3) by the identity the
 * launch names, the metadata record and the creator rules record it signed
 * exist and hash to the signed hashes, the rules are valid for the launch's
 * guard, the message v3 rebuilt from the Launch account hashes to the stored
 * hash, and the LMS signature verifies at the recorded leaf, which the
 * identity's bitmap marks. For an upcoming-launch list: show "signed by its
 * creator's post-quantum identity", the record and the rules (`origin.rules`:
 * their hash and plain-English lines, or "No launch rules") only when
 * `verified`.
 */
export async function verifyAttestation(conn: Connection, launch: PublicKey): Promise<AttestationVerification> {
  if (!(launch instanceof PublicKey)) throw new TypeError("launch must be a PublicKey");
  const [launchAcc, attestationAcc] = await getAccounts(conn, [launch, attestationAddress(launch)]);
  let l: LaunchAccount | null = null;
  const problems: string[] = [];
  if (launchAcc === null || launchAcc === undefined || !launchAcc.owner.equals(PROGRAM_IDS.launchpad)) problems.push(`no launchpad-owned Launch account at ${launch.toBase58()}`);
  else {
    try {
      l = decodeLaunch(launch, launchAcc.data);
    } catch (e) {
      problems.push(`the Launch account cannot be decoded (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  // The identity and the records are named by the attestation itself (checked against the launch below).
  let identityAddr: PublicKey | null = null;
  let recordAddr: PublicKey | null = null;
  let rulesAddr: PublicKey | null = null;
  try {
    if (attestationAcc !== null && attestationAcc !== undefined && attestationAcc.owner.equals(PROGRAM_IDS.launchpad) && attestationAcc.data.length > 0) {
      const a = decodeAttestation(attestationAddress(launch), attestationAcc.data);
      if (a.attested) {
        identityAddr = identityAddressFromId(a.pqIdentity);
        recordAddr = tokenMetaAddress(launch, a.metadataHash);
        rulesAddr = isAllZero(a.rulesHash) ? null : launchRulesAddress(launch, a.rulesHash);
      }
    }
  } catch {
    // Reported by the check below.
  }
  const [identityAcc, recordAcc, rulesAcc] =
    identityAddr === null || recordAddr === null ? [null, null, null] : await getAccounts(conn, rulesAddr === null ? [identityAddr, recordAddr] : [identityAddr, recordAddr, rulesAddr]);
  const r = checkAttestation({
    launchAddress: launch,
    launch: l,
    fallback: null,
    expectedIdentity: l?.pqIdentity ?? null,
    attestation: attestationAcc ?? null,
    identity: identityAcc ?? null,
    tokenMeta: recordAcc ?? null,
    rules: rulesAcc ?? null,
  });
  const all = [...problems, ...r.problems];
  const verified = r.origin !== null && all.length === 0;
  return { verified, problems: all, launch: l, origin: r.origin === null ? null : { ...r.origin, verified }, tokenMeta: r.record, launchRules: r.rulesRecord };
}

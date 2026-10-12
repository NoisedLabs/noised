/**
 * A token's on-chain metadata record (`TokenMeta`; METADATA_ONCHAIN.md §4
 * with METADATA_PROGRAM.md's amendments): name, symbol, a uri mode
 * (`flags`), an optional external uri and a document, written whole by
 * `publish_metadata` at the address its content hashes to, signed (through
 * that hash) by the launch's post-quantum identity, and never modified or
 * closed.
 *
 * ```text
 * metadata_hash = SHA256("PHX-META-V2" || u32le(len) name || u32le(len) symbol || u8 flags
 *                        || u32le(len) uri || u32le(len) doc)          lengths in UTF-8 bytes
 * TokenMeta     = discriminator 8257ae23152c5c13 || version 1 || bump || flags || launch (32)
 *                 || metadata_hash (32) || borsh strings name, symbol, uri, doc     91 + strings
 * address       = ["metadata", launch, metadata_hash] (canonical bump)
 * mint uri      = "" | "data:application/json;base64," + base64(doc) (INLINE_URI) | uri (EXTERNAL_URI)
 * ```
 *
 * Anyone may publish any record under a configured launch, each at its own
 * address: junk records are inert, because `attest_launch` and `launch` use
 * only the hash the identity signed. A reader therefore resolves a token's
 * record only through `Attestation.metadata_hash` (before launch,
 * `fetchTokenMetaForLaunch`) or `Certificate.metadata` (after,
 * `fetchTokenMetaForMint`), never by listing a launch's records.
 *
 * Every field is UTF-8 and every limit counts bytes (a JavaScript `length`
 * counts UTF-16 units: "€" is 1 unit and 3 bytes). `validateTokenMeta`
 * reports problems in the program's own order of checks, so the first one
 * is the error `publish_metadata` would return.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";

import { encodeBase64 } from "../codec/base64.js";
import { bytesEqual, concatBytes, isUint, U8_MAX, u32le, utf8 } from "../codec/bytes.js";
import { METADATA, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { fetchAttestation, fetchCertificate } from "../launch/accounts.js";
import { tokenMetaPda } from "../pda.js";
import { getAccount, ownedBy } from "../rpc/fetch.js";
import type { AttestationAccount, CertificateAccount } from "../types.js";

/** Text (encoded as UTF-8) or its raw bytes. */
export type MetadataText = string | Uint8Array;

/** What a record holds, as given by a caller (strings or raw bytes). */
export interface TokenMetaInput {
  readonly name: MetadataText;
  readonly symbol: MetadataText;
  /** 0 (default: the mint's uri stays empty), `METADATA.FLAG_INLINE_URI` or `METADATA.FLAG_EXTERNAL_URI`. */
  readonly flags?: number | undefined;
  /** Empty unless `FLAG_EXTERNAL_URI` (default ""). */
  readonly uri?: MetadataText | undefined;
  /** The document (`buildMetadataDoc`; default empty). */
  readonly doc?: MetadataText | undefined;
}

/** A record's exact bytes (UTF-8): what is hashed, published and stored. */
export interface TokenMetaRecord {
  readonly name: Uint8Array;
  readonly symbol: Uint8Array;
  readonly flags: number;
  readonly uri: Uint8Array;
  readonly doc: Uint8Array;
}

const HASH_TAG = utf8(METADATA.HASH_TAG);
const INLINE_PREFIX = utf8(METADATA.INLINE_URI_PREFIX);
const EXTERNAL_PREFIX = utf8(METADATA.EXTERNAL_URI_PREFIX);
/** Strict UTF-8 that keeps a leading BOM (a record's bytes must survive a decode and re-encode unchanged). */
const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Lone UTF-16 surrogates: TextEncoder would silently write U+FFFD for them. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function textBytes(field: string, v: MetadataText | undefined): Uint8Array {
  if (v === undefined) return new Uint8Array(0);
  if (typeof v === "string") return utf8(v);
  if (v instanceof Uint8Array) return Uint8Array.from(v);
  throw new TypeError(`${field} must be a string or a Uint8Array`);
}

/** The text of strict UTF-8 `bytes`, or null when they are not UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return STRICT.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The record's bytes (copies; strings encoded as UTF-8). Throws a TypeError
 * for fields of the wrong type and a RangeError for `flags` outside u8;
 * nothing else is judged here (`validateTokenMeta`).
 */
export function tokenMetaRecord(input: TokenMetaInput): TokenMetaRecord {
  if (input === null || typeof input !== "object") throw new TypeError("the metadata record must be an object");
  const flags = input.flags ?? 0;
  if (!isUint(flags, U8_MAX)) throw new RangeError("flags must be an integer in 0..255 (u8)");
  return {
    name: textBytes("name", input.name),
    symbol: textBytes("symbol", input.symbol),
    flags,
    uri: textBytes("uri", input.uri),
    doc: textBytes("doc", input.doc),
  };
}

/** `u32le(len) name || u32le(len) symbol || u8 flags || u32le(len) uri || u32le(len) doc`: `publish_metadata`'s arguments, and what the hash covers after its tag. */
export function tokenMetaBorsh(input: TokenMetaInput): Uint8Array {
  const r = tokenMetaRecord(input);
  return concatBytes([u32le(r.name.length), r.name, u32le(r.symbol.length), r.symbol, Uint8Array.of(r.flags), u32le(r.uri.length), r.uri, u32le(r.doc.length), r.doc]);
}

/**
 * `pq::metadata_hash_v2`: `SHA256("PHX-META-V2" || u32le(len) name ||
 * u32le(len) symbol || u8 flags || u32le(len) uri || u32le(len) doc)` over
 * the UTF-8 bytes. It is the record's address seed and what the attestation
 * message signs.
 */
export function metadataHashV2(input: TokenMetaInput): Uint8Array {
  return sha256(concatBytes([HASH_TAG, tokenMetaBorsh(input)]));
}

/** Bytes of the record's account: `91 + name + symbol + uri + doc` (`TokenMeta::space`). */
export function tokenMetaSpace(input: TokenMetaInput): number {
  const r = tokenMetaRecord(input);
  return METADATA.TOKEN_META_FIXED_LEN + r.name.length + r.symbol.length + r.uri.length + r.doc.length;
}

/** `policy::external_uri_is_valid`: `https://` and at least one more byte, at most 200 bytes, every byte printable ASCII (0x21..=0x7E). */
export function externalUriIsValid(uri: MetadataText): boolean {
  const b = textBytes("uri", uri);
  return (
    b.length > EXTERNAL_PREFIX.length &&
    b.length <= METADATA.MAX_URI_LEN &&
    EXTERNAL_PREFIX.every((x, i) => b[i] === x) &&
    b.every((x) => x >= 0x21 && x <= 0x7e)
  );
}

/** The error a record gets from `publish_metadata` (and `InstructionDidNotDeserialize` for text that is not UTF-8). */
export type TokenMetaErrorName = "InvalidMetadataFlags" | "MetadataTooLong" | "InvalidMetadata" | "InstructionDidNotDeserialize";

/** `validateTokenMeta`'s verdict. */
export interface TokenMetaValidation {
  readonly ok: boolean;
  /** The first error, the one the program would return (null when valid). */
  readonly error: { readonly code: number; readonly name: TokenMetaErrorName } | null;
  /** Every problem as `"field: message"`, in the program's order of checks. */
  readonly errors: string[];
}

const ERROR_CODES: Readonly<Record<TokenMetaErrorName, number>> = {
  InstructionDidNotDeserialize: 102,
  InvalidMetadataFlags: METADATA.ERRORS.InvalidMetadataFlags,
  MetadataTooLong: METADATA.ERRORS.MetadataTooLong,
  InvalidMetadata: METADATA.ERRORS.InvalidMetadata,
};

/**
 * Check a record before anything is signed or sent, exactly as
 * `publish_metadata` (`policy::validate_metadata`) does, in its order:
 *
 * 1. (decoding) every text is UTF-8 (`InstructionDidNotDeserialize`);
 *    strings with a lone UTF-16 surrogate are refused too;
 * 2. `InvalidMetadataFlags` (6045): a bit other than the two uri modes, or both;
 * 3. `MetadataTooLong` (6046): a document over 3,072 bytes or a uri over 200;
 * 4. `InvalidMetadata` (6016): a name outside 1..=32 bytes or a symbol
 *    outside 1..=10; with `FLAG_EXTERNAL_URI`, a uri that is not `https://`
 *    plus at least one printable-ASCII byte;
 * 5. `InvalidMetadataFlags` (6045): a uri without `FLAG_EXTERNAL_URI`, or
 *    `FLAG_INLINE_URI` without a document.
 *
 * `error` is the first failing rule (what the program answers); `errors`
 * lists every problem in that order.
 */
export function validateTokenMeta(input: TokenMetaInput): TokenMetaValidation {
  const problems: { name: TokenMetaErrorName; message: string }[] = [];
  const add = (name: TokenMetaErrorName, message: string): void => {
    problems.push({ name, message });
  };
  if (input === null || typeof input !== "object") throw new TypeError("the metadata record must be an object");
  const flags = input.flags ?? 0;
  if (!isUint(flags, U8_MAX)) add("InvalidMetadataFlags", "flags: must be an integer in 0..255 (u8)");
  const fields = [
    ["name", input.name],
    ["symbol", input.symbol],
    ["uri", input.uri],
    ["doc", input.doc],
  ] as const;
  const bytes: Record<string, Uint8Array> = {};
  for (const [field, v] of fields) {
    if (typeof v === "string" && LONE_SURROGATE.test(v)) add("InstructionDidNotDeserialize", `${field}: contains an unpaired UTF-16 surrogate (not valid text)`);
    const b = textBytes(field, v);
    if (utf8Text(b) === null) add("InstructionDidNotDeserialize", `${field}: is not valid UTF-8`);
    bytes[field] = b;
  }
  const [name, symbol, uri, doc] = [bytes["name"]!, bytes["symbol"]!, bytes["uri"]!, bytes["doc"]!];
  const f = isUint(flags, U8_MAX) ? flags : 0;
  if (isUint(flags, U8_MAX) && f !== 0 && f !== METADATA.FLAG_INLINE_URI && f !== METADATA.FLAG_EXTERNAL_URI) {
    add("InvalidMetadataFlags", `flags: must be 0, ${METADATA.FLAG_INLINE_URI} (inline uri) or ${METADATA.FLAG_EXTERNAL_URI} (external uri), at most one uri mode (is ${f})`);
  }
  if (doc.length > METADATA.MAX_DOC_LEN) add("MetadataTooLong", `doc: must be at most ${METADATA.MAX_DOC_LEN} bytes (is ${doc.length})`);
  if (uri.length > METADATA.MAX_URI_LEN) add("MetadataTooLong", `uri: must be at most ${METADATA.MAX_URI_LEN} bytes (is ${uri.length})`);
  if (name.length < 1 || name.length > METADATA.MAX_NAME_LEN) add("InvalidMetadata", `name: must be 1..=${METADATA.MAX_NAME_LEN} bytes of UTF-8 (is ${name.length})`);
  if (symbol.length < 1 || symbol.length > METADATA.MAX_SYMBOL_LEN) add("InvalidMetadata", `symbol: must be 1..=${METADATA.MAX_SYMBOL_LEN} bytes of UTF-8 (is ${symbol.length})`);
  if (f === METADATA.FLAG_EXTERNAL_URI) {
    if (!externalUriIsValid(uri)) add("InvalidMetadata", `uri: an external uri must be ${METADATA.EXTERNAL_URI_PREFIX} and at least one more byte, at most ${METADATA.MAX_URI_LEN} bytes, every byte printable ASCII (no space, control or non-ASCII character)`);
  } else if (uri.length > 0) {
    add("InvalidMetadataFlags", "uri: must be empty unless the external-uri flag is set");
  }
  if (f === METADATA.FLAG_INLINE_URI && doc.length === 0) add("InvalidMetadataFlags", "doc: an inline uri needs a document");
  const first = problems[0];
  return { ok: problems.length === 0, error: first === undefined ? null : { code: ERROR_CODES[first.name], name: first.name }, errors: problems.map((p) => p.message) };
}

/**
 * The uri `launch` gives the mint for this record (`policy::token_uri`):
 * empty without a uri mode, `"data:application/json;base64," + base64(doc)`
 * (RFC 4648, padded) with `FLAG_INLINE_URI`, the record's own uri with
 * `FLAG_EXTERNAL_URI`. The bytes, as the mint stores them.
 */
export function tokenUriBytes(input: TokenMetaInput): Uint8Array {
  const r = tokenMetaRecord(input);
  if ((r.flags & METADATA.FLAG_INLINE_URI) !== 0) return concatBytes([INLINE_PREFIX, utf8(encodeBase64(r.doc))]);
  if ((r.flags & METADATA.FLAG_EXTERNAL_URI) !== 0) return r.uri;
  return new Uint8Array(0);
}

/** `tokenUriBytes` as text (base64 and a valid external uri are ASCII). */
export function tokenUri(input: TokenMetaInput): string {
  return STRICT.decode(tokenUriBytes(input));
}

/** Bytes of the mint `launch` creates for this record: `386 + name + symbol + uri` (MetadataPointer, TransferHook, TokenMetadata). */
export function launchedMintSpace(input: TokenMetaInput): number {
  const r = tokenMetaRecord(input);
  return METADATA.MINT_BASE_LEN + r.name.length + r.symbol.length + tokenUriBytes(r).length;
}

// --------------------------------------------------------------- account ---

/** A decoded `TokenMeta` account, checked against its own address. */
export interface TokenMetaAccount {
  /** The account address, `["metadata", launch, metadataHash]`. */
  readonly publicKey: PublicKey;
  readonly version: number;
  readonly bump: number;
  readonly flags: number;
  readonly launch: PublicKey;
  /** `metadataHashV2` of the content (checked). */
  readonly metadataHash: Uint8Array;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  /** The document's bytes (`parseMetadataDoc` reads it). */
  readonly doc: Uint8Array;
  /** The exact bytes (what the hash covers and the mint must hold). */
  readonly record: TokenMetaRecord;
  /** The uri `launch` gives the mint (`tokenUri`). */
  readonly tokenUri: string;
}

const DISCRIMINATOR = Uint8Array.from(METADATA.TOKEN_META_DISCRIMINATOR);
const OFF = METADATA.TOKEN_META_OFFSETS;

/**
 * Decode a `TokenMeta` account (discriminator `8257ae23152c5c13`, version 1,
 * then bump, flags, launch, metadata hash and the four borsh strings; no
 * trailing byte). Refuses an account that is not the PDA of its own launch
 * and hash with its canonical bump, whose hash is not its content's, or
 * whose text is not UTF-8: only `publish_metadata` writes such an account,
 * whole and validated.
 */
export function decodeTokenMeta(publicKey: PublicKey, data: Uint8Array): TokenMetaAccount {
  if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
  if (data.length < METADATA.TOKEN_META_FIXED_LEN) throw new Error(`a TokenMeta account is at least ${METADATA.TOKEN_META_FIXED_LEN} bytes, got ${data.length}`);
  if (!bytesEqual(data.subarray(0, 8), DISCRIMINATOR)) throw new Error("not a TokenMeta account (discriminator)");
  if (data[OFF.VERSION] !== METADATA.TOKEN_META_VERSION) throw new Error(`TokenMeta account has version ${data[OFF.VERSION]}; this SDK reads version ${METADATA.TOKEN_META_VERSION}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off: number = OFF.NAME;
  const field = (what: string): Uint8Array => {
    if (off + 4 > data.length) throw new Error(`TokenMeta ${what} is truncated`);
    const n = view.getUint32(off, true);
    off += 4;
    if (n > data.length - off) throw new Error(`TokenMeta ${what} is truncated`);
    const b = data.slice(off, off + n);
    off += n;
    return b;
  };
  const record: TokenMetaRecord = { name: field("name"), symbol: field("symbol"), flags: data[OFF.FLAGS]!, uri: field("uri"), doc: field("doc") };
  if (off !== data.length) throw new Error("TokenMeta account has bytes after its document");
  const text = (what: string, b: Uint8Array): string => {
    const t = utf8Text(b);
    if (t === null) throw new Error(`TokenMeta ${what} is not UTF-8`);
    return t;
  };
  text("doc", record.doc);
  const launch = new PublicKey(data.slice(OFF.LAUNCH, OFF.LAUNCH + 32));
  const metadataHash = data.slice(OFF.METADATA_HASH, OFF.METADATA_HASH + 32);
  if (!bytesEqual(metadataHashV2(record), metadataHash)) throw new Error("TokenMeta account's metadata hash is not the hash of its content");
  const [address, bump] = tokenMetaPda(launch, metadataHash);
  if (!address.equals(publicKey) || data[OFF.BUMP] !== bump) throw new Error("TokenMeta account is not at the canonical address of its launch and hash");
  return {
    publicKey,
    version: data[OFF.VERSION]!,
    bump,
    flags: record.flags,
    launch,
    metadataHash,
    name: text("name", record.name),
    symbol: text("symbol", record.symbol),
    uri: text("uri", record.uri),
    doc: record.doc,
    record,
    tokenUri: text("uri", tokenUriBytes(record)),
  };
}

/**
 * The bytes `publish_metadata` writes for this record under `launch`
 * (version 1, the canonical bump): for mocks and tests that need the exact
 * account a cluster would hold.
 */
export function tokenMetaAccountData(launch: PublicKey, input: TokenMetaInput): Uint8Array {
  const r = tokenMetaRecord(input);
  const hash = metadataHashV2(r);
  const [, bump] = tokenMetaPda(launch, hash);
  const strings = [r.name, r.symbol, r.uri, r.doc].flatMap((b) => [u32le(b.length), b]);
  return concatBytes([DISCRIMINATOR, Uint8Array.of(METADATA.TOKEN_META_VERSION, bump, r.flags), launch.toBytes(), hash, ...strings]);
}

/** `fetchTokenMeta` options. */
export interface FetchTokenMetaOptions {
  /** Default `confirmed`. */
  readonly commitment?: Commitment | undefined;
}

/**
 * The record `metadataHash` names for `launch` (null when nothing is
 * published there). The address is the content's hash, so this returns
 * exactly the record of that hash or nothing: use it for a hash you hold
 * (your own draft's); for someone's token, go through its attestation or
 * certificate (`fetchTokenMetaForLaunch`, `fetchTokenMetaForMint`).
 */
export async function fetchTokenMeta(conn: Connection, launch: PublicKey, metadataHash: Uint8Array, opts: FetchTokenMetaOptions = {}): Promise<TokenMetaAccount | null> {
  const [address] = tokenMetaPda(launch, metadataHash);
  const acc = ownedBy(await getAccount(conn, address, opts.commitment ?? "confirmed"), PROGRAM_IDS.launchpad, "TokenMeta");
  if (acc === null) return null;
  const record = decodeTokenMeta(address, acc.data);
  if (!record.launch.equals(launch) || !bytesEqual(record.metadataHash, metadataHash)) throw new Error("the TokenMeta account names another launch or hash");
  return record;
}

/**
 * Before launch: the record a launch's attestation signed, resolved ONLY
 * through `Attestation.metadata_hash` (null while the launch has no attested
 * attestation). Throws when the attested record is missing (records are
 * never closed: the RPC is behind or dishonest).
 */
export async function fetchTokenMetaForLaunch(conn: Connection, launch: PublicKey): Promise<{ attestation: AttestationAccount; tokenMeta: TokenMetaAccount } | null> {
  const attestation = await fetchAttestation(conn, launch);
  if (attestation === null || !attestation.attested) return null;
  const tokenMeta = await fetchTokenMeta(conn, launch, attestation.metadataHash);
  if (tokenMeta === null) throw new Error("the launch's attestation names a metadata record that does not exist (an RPC that is behind or dishonest)");
  return { attestation, tokenMeta };
}

/**
 * After launch: a mint's record, resolved ONLY through its certificate's
 * `metadata` (null when the mint has no Noised certificate). The record must
 * belong to the certificate's launch and sit at the address of its own hash.
 */
export async function fetchTokenMetaForMint(conn: Connection, mint: PublicKey): Promise<{ certificate: CertificateAccount; tokenMeta: TokenMetaAccount } | null> {
  const certificate = await fetchCertificate(conn, mint);
  if (certificate === null) return null;
  if (!certificate.baseMint.equals(mint)) throw new Error("certificate does not belong to this mint");
  const acc = ownedBy(await getAccount(conn, certificate.metadata), PROGRAM_IDS.launchpad, "TokenMeta");
  if (acc === null) throw new Error(`the certificate names the metadata record ${certificate.metadata.toBase58()}, which does not exist`);
  const tokenMeta = decodeTokenMeta(certificate.metadata, acc.data);
  if (!tokenMeta.launch.equals(certificate.launch)) throw new Error("the certificate's metadata record belongs to another launch");
  return { certificate, tokenMeta };
}

// ----------------------------------------------------------------- event ---

/** `MetadataPublished` (785c2aaf9fae1871), emitted when `publish_metadata` writes a record (not on an idempotent repeat). */
export interface MetadataPublishedEvent {
  readonly launch: PublicKey;
  readonly tokenMeta: PublicKey;
  readonly metadataHash: Uint8Array;
  readonly flags: number;
  readonly uriLen: number;
  readonly docLen: number;
}

/** Decode `discriminator || payload` of a `MetadataPublished` event ("Program data:" bytes); null for any other bytes. */
export function decodeMetadataPublishedEvent(data: Uint8Array): MetadataPublishedEvent | null {
  const codec = idlCodecs().launchpad;
  const ev = codec.idl.events?.find((e) => e.name === "MetadataPublished");
  if (ev === undefined) throw new Error("the launchpad IDL has no MetadataPublished event");
  const disc = Uint8Array.from(ev.discriminator);
  if (data.length <= disc.length || !bytesEqual(data.subarray(0, disc.length), disc)) return null;
  return codec.decodeType<MetadataPublishedEvent>("MetadataPublished", data.subarray(disc.length));
}

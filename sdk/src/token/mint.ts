/**
 * Strict SPL Token / Token-2022 mint parsing, mirroring what our programs
 * do on-chain with `spl-token-2022-interface` 2.1.0:
 * `StateWithExtensions::<Mint>::unpack` (length, multisig size, initialized
 * flag, COption tags, zero padding, account-type byte) and
 * `get_extension_types` (TLV walk that stops at an Uninitialized entry and
 * fails on extension types the interface does not know).
 *
 * The vault (`open_vault`), the shield (`create_shield`) and the launchpad
 * (`launch` post-conditions) all refuse mints this parser refuses, so client
 * checks built on it give the same answers.
 */
import { PublicKey } from "@solana/web3.js";

import { isAllZero } from "../codec/bytes.js";
import { KNOWN_ACCOUNTS } from "../constants.js";

export const MINT_SIZE = 82;
export const TOKEN_ACCOUNT_SIZE = 165;
export const MULTISIG_SIZE = 355;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;

/** Token-2022 extension type numbers (`ExtensionType` discriminants). */
export const ExtensionType = {
  Uninitialized: 0,
  TransferFeeConfig: 1,
  TransferFeeAmount: 2,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  ConfidentialTransferAccount: 5,
  DefaultAccountState: 6,
  ImmutableOwner: 7,
  MemoTransfer: 8,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  CpiGuard: 11,
  PermanentDelegate: 12,
  NonTransferableAccount: 13,
  TransferHook: 14,
  TransferHookAccount: 15,
  ConfidentialTransferFeeConfig: 16,
  ConfidentialTransferFeeAmount: 17,
  MetadataPointer: 18,
  TokenMetadata: 19,
  GroupPointer: 20,
  TokenGroup: 21,
  GroupMemberPointer: 22,
  TokenGroupMember: 23,
  ConfidentialMintBurn: 24,
  ScaledUiAmount: 25,
  Pausable: 26,
  PausableAccount: 27,
} as const;

/**
 * Highest extension type `spl-token-2022-interface` 2.1.0 (the version every
 * Noised program is built with) can parse. Mints carrying a newer type (e.g.
 * 28 = PermissionedBurn in Token-2022 v11) fail to parse on-chain and are
 * therefore refused by `open_vault` and `create_shield`.
 */
export const MAX_KNOWN_EXTENSION_TYPE = 27;

export function extensionName(t: number): string {
  for (const [k, v] of Object.entries(ExtensionType)) if (v === t) return k;
  return `Unknown(${t})`;
}

export class MintParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintParseError";
  }
}

export interface TlvEntry {
  type: number;
  data: Uint8Array;
}

export interface ParsedMint {
  programId: PublicKey;
  mintAuthority: PublicKey | null;
  supply: bigint;
  decimals: number;
  freezeAuthority: PublicKey | null;
  /** Raw TLV region (after the account-type byte); empty for SPL Token mints. */
  tlvData: Uint8Array;
  /** Extensions in TLV order, up to the first Uninitialized entry. */
  extensions: TlvEntry[];
  /** Bytes of `tlvData` the extensions occupy (the rest is zero padding). */
  tlvUsedLength: number;
}

function cOptionPubkey(data: Uint8Array, offset: number, field: string): PublicKey | null {
  const tag = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
  if (tag === 0) return null;
  if (tag !== 1) throw new MintParseError(`${field}: invalid COption tag ${tag}`);
  return new PublicKey(data.slice(offset + 4, offset + 36));
}

/**
 * `get_tlv_data_info`: entries up to the first Uninitialized type; unknown
 * types and overruns fail. `usedLength` is where the walk stopped (trailing
 * bytes after it are padding).
 */
export function parseTlvInfo(tlv: Uint8Array, maxKnownType = MAX_KNOWN_EXTENSION_TYPE): { entries: TlvEntry[]; usedLength: number } {
  const view = new DataView(tlv.buffer, tlv.byteOffset, tlv.byteLength);
  const entries: TlvEntry[] = [];
  let start = 0;
  while (start < tlv.length) {
    const lengthStart = start + 2;
    const valueStart = lengthStart + 2;
    if (tlv.length < lengthStart) break; // not enough bytes for another type: end of data
    const type = view.getUint16(start, true);
    if (type > maxKnownType) throw new MintParseError(`unknown extension type ${type}`);
    if (type === ExtensionType.Uninitialized) break;
    if (tlv.length < valueStart) throw new MintParseError("truncated extension length");
    const length = view.getUint16(lengthStart, true);
    const end = valueStart + length;
    if (end > tlv.length) throw new MintParseError(`extension ${extensionName(type)} overruns the account`);
    entries.push({ type, data: tlv.slice(valueStart, end) });
    start = end;
  }
  return { entries, usedLength: start };
}

export function parseTlv(tlv: Uint8Array, maxKnownType = MAX_KNOWN_EXTENSION_TYPE): TlvEntry[] {
  return parseTlvInfo(tlv, maxKnownType).entries;
}

/**
 * Parse a mint owned by SPL Token or Token-2022 exactly as the on-chain
 * interface does; throws `MintParseError` where the programs would fail.
 */
export function parseMint(owner: PublicKey, data: Uint8Array, maxKnownType = MAX_KNOWN_EXTENSION_TYPE): ParsedMint {
  const isToken2022 = owner.equals(KNOWN_ACCOUNTS.token2022);
  if (!isToken2022 && !owner.equals(KNOWN_ACCOUNTS.splToken)) throw new MintParseError(`not owned by a token program (${owner.toBase58()})`);
  if (data.length === MULTISIG_SIZE || data.length < MINT_SIZE) throw new MintParseError(`invalid mint account length ${data.length}`);
  if (!isToken2022 && data.length !== MINT_SIZE) throw new MintParseError(`SPL Token mint must be ${MINT_SIZE} bytes`);
  const mintAuthority = cOptionPubkey(data, 0, "mint authority");
  const supply = new DataView(data.buffer, data.byteOffset + 36, 8).getBigUint64(0, true);
  const decimals = data[44]!;
  const initialized = data[45]!;
  if (initialized > 1) throw new MintParseError(`invalid is_initialized byte ${initialized}`);
  const freezeAuthority = cOptionPubkey(data, 46, "freeze authority");
  if (initialized !== 1) throw new MintParseError("mint is not initialized");

  let tlvData: Uint8Array = new Uint8Array(0);
  const rest = data.subarray(MINT_SIZE);
  if (rest.length > 0) {
    const accountTypeIndex = TOKEN_ACCOUNT_SIZE - MINT_SIZE; // 83
    const tlvStart = accountTypeIndex + 1;
    if (rest.length < tlvStart) throw new MintParseError("extension data too short for the account type");
    if (!isAllZero(rest.subarray(0, accountTypeIndex))) throw new MintParseError("non-zero padding before the account type");
    const accountType = rest[accountTypeIndex]!;
    if (accountType !== ACCOUNT_TYPE_MINT) {
      throw new MintParseError(accountType === ACCOUNT_TYPE_ACCOUNT ? "account is a token account, not a mint" : `invalid account type ${accountType}`);
    }
    tlvData = rest.slice(tlvStart);
  }
  const { entries, usedLength } = parseTlvInfo(tlvData, maxKnownType);
  return {
    programId: isToken2022 ? KNOWN_ACCOUNTS.token2022 : KNOWN_ACCOUNTS.splToken,
    mintAuthority,
    supply,
    decimals,
    freezeAuthority,
    tlvData,
    extensions: entries,
    tlvUsedLength: usedLength,
  };
}

export function findExtension(mint: ParsedMint, type: number): Uint8Array | null {
  return mint.extensions.find((e) => e.type === type)?.data ?? null;
}

/** `OptionalNonZeroPubkey`: all-zero means None. */
export function optionalNonZeroPubkey(b: Uint8Array): PublicKey | null {
  if (b.length !== 32) throw new MintParseError("OptionalNonZeroPubkey must be 32 bytes");
  return isAllZero(b) ? null : new PublicKey(b);
}

function sized(mint: ParsedMint, type: number, len: number): Uint8Array | null {
  const data = findExtension(mint, type);
  if (data === null) return null;
  // `get_extension::<T>()` requires the exact Pod size.
  if (data.length !== len) throw new MintParseError(`${extensionName(type)} has length ${data.length}, expected ${len}`);
  return data;
}

export function transferHookOf(mint: ParsedMint): { authority: PublicKey | null; programId: PublicKey | null } | null {
  const d = sized(mint, ExtensionType.TransferHook, 64);
  return d === null ? null : { authority: optionalNonZeroPubkey(d.subarray(0, 32)), programId: optionalNonZeroPubkey(d.subarray(32, 64)) };
}

export function metadataPointerOf(mint: ParsedMint): { authority: PublicKey | null; metadataAddress: PublicKey | null } | null {
  const d = sized(mint, ExtensionType.MetadataPointer, 64);
  return d === null ? null : { authority: optionalNonZeroPubkey(d.subarray(0, 32)), metadataAddress: optionalNonZeroPubkey(d.subarray(32, 64)) };
}

export interface TransferFee {
  epoch: bigint;
  maximumFee: bigint;
  basisPoints: number;
}

export interface TransferFeeConfig {
  configAuthority: PublicKey | null;
  withdrawWithheldAuthority: PublicKey | null;
  withheldAmount: bigint;
  olderTransferFee: TransferFee;
  newerTransferFee: TransferFee;
}

export function transferFeeConfigOf(mint: ParsedMint): TransferFeeConfig | null {
  const d = sized(mint, ExtensionType.TransferFeeConfig, 108);
  if (d === null) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const fee = (o: number): TransferFee => ({
    epoch: v.getBigUint64(o, true),
    maximumFee: v.getBigUint64(o + 8, true),
    basisPoints: v.getUint16(o + 16, true),
  });
  return {
    configAuthority: optionalNonZeroPubkey(d.subarray(0, 32)),
    withdrawWithheldAuthority: optionalNonZeroPubkey(d.subarray(32, 64)),
    withheldAmount: v.getBigUint64(64, true),
    olderTransferFee: fee(72),
    newerTransferFee: fee(90),
  };
}

export function permanentDelegateOf(mint: ParsedMint): PublicKey | null | undefined {
  const d = sized(mint, ExtensionType.PermanentDelegate, 32);
  return d === null ? undefined : optionalNonZeroPubkey(d);
}

export function mintCloseAuthorityOf(mint: ParsedMint): PublicKey | null | undefined {
  const d = sized(mint, ExtensionType.MintCloseAuthority, 32);
  return d === null ? undefined : optionalNonZeroPubkey(d);
}

export function pausableOf(mint: ParsedMint): { authority: PublicKey | null; paused: boolean } | null {
  const d = sized(mint, ExtensionType.Pausable, 33);
  return d === null ? null : { authority: optionalNonZeroPubkey(d.subarray(0, 32)), paused: d[32] === 1 };
}

/** `DefaultAccountState`: 0 uninitialized, 1 initialized, 2 frozen. */
export function defaultAccountStateOf(mint: ParsedMint): number | null {
  const d = sized(mint, ExtensionType.DefaultAccountState, 1);
  return d === null ? null : d[0]!;
}

export interface TokenMetadata {
  updateAuthority: PublicKey | null;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  additionalMetadata: [string, string][];
}

/** Token-2022 `TokenMetadata` (variable length, borsh). */
export function tokenMetadataOf(mint: ParsedMint): TokenMetadata | null {
  const d = findExtension(mint, ExtensionType.TokenMetadata);
  if (d === null) return null;
  if (d.length < 64) throw new MintParseError("TokenMetadata too short");
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const dec = new TextDecoder("utf-8", { fatal: true });
  let off = 64;
  const str = (): string => {
    if (off + 4 > d.length) throw new MintParseError("TokenMetadata truncated");
    const n = view.getUint32(off, true);
    off += 4;
    if (off + n > d.length) throw new MintParseError("TokenMetadata truncated");
    const s = dec.decode(d.subarray(off, off + n));
    off += n;
    return s;
  };
  const name = str();
  const symbol = str();
  const uri = str();
  if (off + 4 > d.length) throw new MintParseError("TokenMetadata truncated");
  const count = view.getUint32(off, true);
  off += 4;
  const additionalMetadata: [string, string][] = [];
  for (let i = 0; i < count; i++) additionalMetadata.push([str(), str()]);
  return {
    updateAuthority: optionalNonZeroPubkey(d.subarray(0, 32)),
    mint: new PublicKey(d.subarray(32, 64)),
    name,
    symbol,
    uri,
    additionalMetadata,
  };
}

// ------------------------------------------------------- token accounts ---

export interface ParsedTokenAccount {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  /** 0 uninitialized, 1 initialized, 2 frozen. */
  state: number;
}

/** Token-2022 token-account extensions (after the 165-byte base and the account-type byte); none for a 165-byte account. */
export function tokenAccountExtensions(data: Uint8Array): TlvEntry[] {
  if (data.length <= TOKEN_ACCOUNT_SIZE + 1) return [];
  return parseTlvInfo(data.subarray(TOKEN_ACCOUNT_SIZE + 1)).entries;
}

/**
 * Whether a token account has Token-2022's `ImmutableOwner` extension: its
 * owner can never be reassigned. Every Token-2022 associated token account
 * has it; while a Launch Guard is on, its hook refuses transfers (other than
 * sells) into a token account without it (`MutableOwner`, 6010).
 */
export function hasImmutableOwner(data: Uint8Array): boolean {
  return tokenAccountExtensions(data).some((e) => e.type === ExtensionType.ImmutableOwner);
}

/** Base token-account fields (shared by SPL Token and Token-2022). */
export function parseTokenAccount(owner: PublicKey, data: Uint8Array): ParsedTokenAccount {
  if (!owner.equals(KNOWN_ACCOUNTS.token2022) && !owner.equals(KNOWN_ACCOUNTS.splToken)) {
    throw new MintParseError(`token account not owned by a token program (${owner.toBase58()})`);
  }
  if (data.length < TOKEN_ACCOUNT_SIZE || data.length === MULTISIG_SIZE) throw new MintParseError(`invalid token account length ${data.length}`);
  if (data.length > TOKEN_ACCOUNT_SIZE && data[TOKEN_ACCOUNT_SIZE] !== ACCOUNT_TYPE_ACCOUNT) {
    throw new MintParseError("not a token account (account type)");
  }
  const state = data[108]!;
  if (state === 0 || state > 2) throw new MintParseError(`token account state ${state}`);
  return {
    mint: new PublicKey(data.slice(0, 32)),
    owner: new PublicKey(data.slice(32, 64)),
    amount: new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true),
    state,
  };
}

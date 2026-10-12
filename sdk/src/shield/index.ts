/**
 * Shield client (SPEC §2): wrap a token 1:1 into its zToken (Token-2022 with
 * Confidential Balances) and unwrap it again.
 *
 * Confidential operations on zTokens (configure account, deposit, apply
 * pending balance, confidential transfer, withdraw) are plain Token-2022
 * instructions with zero-knowledge proofs. This SDK does not generate those
 * proofs; use the `spl-token` CLI (5.6+, `--confidential`), see README.
 */
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";

import { isU64 } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { associatedTokenAddress, shieldAddresses } from "../pda.js";
import { getAccount, getAccounts, ownedBy, type RawAccount } from "../rpc/fetch.js";
import { resolveHookAccounts } from "../token/hook.js";
import { ExtensionType, extensionName, MintParseError, parseMint, type ParsedMint } from "../token/mint.js";
import type { ShieldAccount } from "../types.js";

export { shieldAddresses };

/** Base-mint extensions `create_shield` accepts (programs/noised-shield/src/policy.rs). */
export const SHIELD_ALLOWED_EXTENSIONS: readonly number[] = [
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.TransferHook,
  ExtensionType.TransferFeeConfig,
];

export const SHIELD_CREATE_COMPUTE_UNITS = 400_000;

/** Mirror of `create_shield`'s base-mint policy: allowlisted extensions only, unknown types refused. */
export function shieldMintPolicy(account: RawAccount | null): { eligible: boolean; refusals: string[]; tokenProgram: PublicKey | null } {
  if (account === null || account.data.length === 0) return { eligible: false, refusals: ["The base mint does not exist."], tokenProgram: null };
  let mint: ParsedMint;
  try {
    mint = parseMint(account.owner, account.data);
  } catch (e) {
    const why = e instanceof MintParseError ? e.message : String(e);
    return { eligible: false, refusals: [`The shield program cannot accept this mint (${why}).`], tokenProgram: null };
  }
  const refusals = mint.extensions
    .filter((x) => !SHIELD_ALLOWED_EXTENSIONS.includes(x.type))
    .map((x) => `Extension ${extensionName(x.type)} is not accepted (only MetadataPointer, TokenMetadata, TransferHook, TransferFeeConfig).`);
  return { eligible: refusals.length === 0, refusals, tokenProgram: mint.programId };
}

interface RawShield {
  version: number;
  bump: number;
  authorityBump: number;
  zMintBump: number;
  decimals: number;
  baseMint: PublicKey;
  baseTokenProgram: PublicKey;
  zMint: PublicKey;
  escrow: PublicKey;
  createdAt: bigint;
}

export function decodeShield(publicKey: PublicKey, data: Uint8Array): ShieldAccount {
  return { ...idlCodecs().shield.decodeAccount<RawShield>("Shield", data), publicKey };
}

/** The shield of `baseMint`, checked against its PDAs, or null if none exists. */
export async function fetchShield(conn: Connection, baseMint: PublicKey): Promise<ShieldAccount | null> {
  const { shield } = shieldAddresses(baseMint);
  const acc = ownedBy(await getAccount(conn, shield), PROGRAM_IDS.shield, "Shield");
  if (acc === null) return null;
  const s = decodeShield(shield, acc.data);
  const expected = shieldAddresses(baseMint, s.baseTokenProgram);
  if (!s.baseMint.equals(baseMint) || !s.zMint.equals(expected.zMint) || !s.escrow.equals(expected.escrow)) {
    throw new Error("shield account does not match its derived addresses");
  }
  return s;
}

async function finish(conn: Connection, feePayer: PublicKey, ixs: TransactionInstruction[]): Promise<Transaction> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/** `create_shield` for `baseMint` (permissionless, once per base mint). */
export async function buildCreateShieldTx(conn: Connection, payer: PublicKey, baseMint: PublicKey): Promise<Transaction> {
  const mintAcc = await getAccount(conn, baseMint);
  const policy = shieldMintPolicy(mintAcc);
  if (!policy.eligible || policy.tokenProgram === null) throw new Error(`create_shield would refuse this mint: ${policy.refusals.join(" ")}`);
  const a = shieldAddresses(baseMint, policy.tokenProgram);
  const existing = await getAccount(conn, a.shield);
  if (existing !== null && existing.data.length > 0) throw new Error("this base mint already has a shield");
  const ix = buildInstruction(idlCodecs().shield, PROGRAM_IDS.shield, "create_shield", {
    payer,
    baseMint,
    shield: a.shield,
    shieldAuthority: a.authority,
    zMint: a.zMint,
    escrow: a.escrow,
    baseTokenProgram: policy.tokenProgram,
  });
  return finish(conn, payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: SHIELD_CREATE_COMPUTE_UNITS }), ix]);
}

async function shieldContext(conn: Connection, baseMint: PublicKey) {
  const shield = await fetchShield(conn, baseMint);
  if (shield === null) throw new Error("this base mint has no shield (create it first)");
  const [mintAcc] = await getAccounts(conn, [baseMint]);
  if (mintAcc === null || mintAcc === undefined) throw new Error("base mint does not exist");
  const parsed = parseMint(mintAcc.owner, mintAcc.data);
  if (!parsed.programId.equals(shield.baseTokenProgram)) throw new Error("base mint's token program changed");
  return { shield, parsed, authority: shieldAddresses(baseMint, shield.baseTokenProgram).authority };
}

/** `wrap`: lock `amount` base tokens in the escrow and receive zTokens (what the escrow received). */
export async function buildWrapTx(conn: Connection, owner: PublicKey, baseMint: PublicKey, amount: bigint): Promise<Transaction> {
  if (!isU64(amount) || amount === 0n) throw new RangeError("amount must be a positive u64");
  const { shield, parsed, authority } = await shieldContext(conn, baseMint);
  const userBase = associatedTokenAddress(owner, baseMint, shield.baseTokenProgram);
  const userZ = associatedTokenAddress(owner, shield.zMint, KNOWN_ACCOUNTS.token2022);
  const hook = await resolveHookAccounts(conn, baseMint, parsed, [{ source: userBase, destination: shield.escrow, authority: owner, amount }]);
  const ix = buildInstruction(
    idlCodecs().shield,
    PROGRAM_IDS.shield,
    "wrap",
    {
      user: owner,
      shield: shield.publicKey,
      shieldAuthority: authority,
      baseMint,
      zMint: shield.zMint,
      escrow: shield.escrow,
      userBase,
      userZ,
      baseTokenProgram: shield.baseTokenProgram,
    },
    { amount },
    hook,
  );
  return finish(conn, owner, [createAssociatedTokenAccountIdempotentInstruction(owner, userZ, owner, shield.zMint, KNOWN_ACCOUNTS.token2022), ix]);
}

/** `unwrap`: burn `amount` zTokens from the owner's public balance and release `amount` base tokens. */
export async function buildUnwrapTx(conn: Connection, owner: PublicKey, baseMint: PublicKey, amount: bigint): Promise<Transaction> {
  if (!isU64(amount) || amount === 0n) throw new RangeError("amount must be a positive u64");
  const { shield, parsed, authority } = await shieldContext(conn, baseMint);
  const userBase = associatedTokenAddress(owner, baseMint, shield.baseTokenProgram);
  const userZ = associatedTokenAddress(owner, shield.zMint, KNOWN_ACCOUNTS.token2022);
  const hook = await resolveHookAccounts(conn, baseMint, parsed, [{ source: shield.escrow, destination: userBase, authority, amount }]);
  const ix = buildInstruction(
    idlCodecs().shield,
    PROGRAM_IDS.shield,
    "unwrap",
    {
      user: owner,
      shield: shield.publicKey,
      shieldAuthority: authority,
      baseMint,
      zMint: shield.zMint,
      escrow: shield.escrow,
      userBase,
      userZ,
      baseTokenProgram: shield.baseTokenProgram,
    },
    { amount },
    hook,
  );
  return finish(conn, owner, [createAssociatedTokenAccountIdempotentInstruction(owner, userBase, owner, baseMint, shield.baseTokenProgram), ix]);
}

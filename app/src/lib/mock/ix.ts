/**
 * MOCK instruction construction. Instructions carry the real program ids,
 * account lists in IDL order (checked by test/idl-layouts.test.ts) and data
 * encoded by the SDK's IDL codecs, so transaction reviews (programs, signers,
 * writable accounts, size) look like production.
 */
import { associatedTokenAddress, computeBudgetInstructions, idlCodecs, KNOWN_ACCOUNTS, noisedHookAccounts, PROGRAM_IDS, WSOL_MINT, type ComputeBudgetOptions } from "@noisedlabs/sdk";
import { PublicKey, Transaction, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { Buffer } from "buffer";

import { utf8 } from "./bytes";

/** Writable account meta. */
export const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
/** Read-only account meta. */
export const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

type CodecName = "launchpad" | "vault" | "shield" | "dbc" | "dammV2";

const PROGRAM_OF: Readonly<Record<CodecName, PublicKey>> = {
  launchpad: PROGRAM_IDS.launchpad,
  vault: PROGRAM_IDS.vault,
  shield: PROGRAM_IDS.shield,
  dbc: PROGRAM_IDS.dbc,
  dammV2: PROGRAM_IDS.dammV2,
};

/** An Anchor instruction whose data (discriminator + borsh args) the SDK encodes from the program's IDL. */
export function idlIx(codec: CodecName, name: string, keys: AccountMeta[], args: Record<string, unknown> = {}): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAM_OF[codec], keys, data: Buffer.from(idlCodecs()[codec].encodeInstruction(name, args)) });
}

/** `snake_case` IDL account name to the camelCase key the SDK's builders use. */
const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/**
 * An Anchor instruction whose ACCOUNT LIST also comes from the IDL, like the
 * SDK's own builders: accounts are named (camelCase), order, signer and
 * writable flags and fixed addresses are the IDL's, and an absent optional
 * account (`null`) is the program id, as Anchor encodes `None`. An unknown
 * or missing name throws, so the mock cannot drift from a new IDL.
 */
export function namedIx(codec: CodecName, name: string, accounts: Record<string, PublicKey | null>, args: Record<string, unknown> = {}, remaining: readonly AccountMeta[] = []): TransactionInstruction {
  const c = idlCodecs()[codec];
  const programId = PROGRAM_OF[codec];
  const def = c.instruction(name);
  const used = new Set<string>();
  const keys: AccountMeta[] = [];
  for (const acc of def.accounts) {
    const key = camel(acc.name);
    used.add(key);
    const given = accounts[key];
    if (acc.address !== undefined) {
      const fixed = new PublicKey(acc.address);
      if (given !== undefined && given !== null && !given.equals(fixed)) throw new Error(`${name}: account ${key} must be ${acc.address}`);
      keys.push({ pubkey: fixed, isSigner: acc.signer === true, isWritable: acc.writable === true });
    } else if (given === null) {
      if (acc.optional !== true) throw new Error(`${name}: account ${key} is required`);
      keys.push({ pubkey: programId, isSigner: false, isWritable: false });
    } else if (given === undefined) {
      throw new Error(`${name}: missing account ${key}`);
    } else {
      keys.push({ pubkey: given, isSigner: acc.signer === true, isWritable: acc.writable === true });
    }
  }
  const unknown = Object.keys(accounts).filter((k) => !used.has(k));
  if (unknown.length > 0) throw new Error(`${name}: unknown account(s) ${unknown.join(", ")}`);
  return new TransactionInstruction({ programId, keys: [...keys, ...remaining], data: Buffer.from(c.encodeInstruction(name, args)) });
}

/** A random 32-byte value in base58 (the simulated chain accepts any blockhash). */
export function fakeBlockhash(): string {
  return new PublicKey(crypto.getRandomValues(new Uint8Array(32))).toBase58();
}

export function legacyTx(feePayer: PublicKey, instructions: TransactionInstruction[]): Transaction {
  const tx = new Transaction({ feePayer, blockhash: fakeBlockhash(), lastValidBlockHeight: 0 });
  tx.add(...instructions);
  return tx;
}

/** Like the SDK's builders: SetComputeUnitLimit (the builder's default or `opts.computeUnitLimit`), SetComputeUnitPrice when a price is given, then the instructions. */
export function budgetedTx(feePayer: PublicKey, instructions: TransactionInstruction[], defaultUnits: number, opts: ComputeBudgetOptions = {}): Transaction {
  return legacyTx(feePayer, [...computeBudgetInstructions(opts, defaultUnits), ...instructions]);
}

/** Associated Token Account program `CreateIdempotent` (discriminator 1). */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  const ata = associatedTokenAddress(owner, mint, tokenProgram);
  return new TransactionInstruction({
    programId: KNOWN_ACCOUNTS.associatedToken,
    keys: [w(payer, true), w(ata), r(owner), r(mint), r(KNOWN_ACCOUNTS.system), r(tokenProgram)],
    data: Buffer.from(Uint8Array.of(1)),
  });
}

/** SPL Token `SyncNative` (17): the wSOL balance becomes the account's lamports. */
export function syncNativeIx(account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: KNOWN_ACCOUNTS.splToken, keys: [w(account)], data: Buffer.from(Uint8Array.of(17)) });
}

/** SPL Token `CloseAccount` (9): unwraps wSOL back to SOL. */
export function closeAccountIx(account: PublicKey, destination: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: KNOWN_ACCOUNTS.splToken,
    keys: [w(account), w(destination), r(owner, true)],
    data: Buffer.from(Uint8Array.of(9)),
  });
}

/**
 * The Launch Guard's four accounts appended to a direct Token-2022
 * `TransferChecked`, in the order `spl-transfer-hook-interface` resolves them
 * off-chain (the SDK's "resolver" order): the resolved extras (policy PDA,
 * instructions sysvar), then the hook program, then the meta list.
 */
export function hookTransferExtras(mint: PublicKey): AccountMeta[] {
  return noisedHookAccounts(mint, "resolver");
}

/** Token `TransferChecked` (12) with optional transfer-hook extras. */
export function transferCheckedIx(args: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
  tokenProgram: PublicKey;
  hookActive: boolean;
}): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, args.amount, true);
  data[9] = args.decimals;
  return new TransactionInstruction({
    programId: args.tokenProgram,
    keys: [w(args.source), r(args.mint), w(args.destination), r(args.owner, true), ...(args.hookActive ? hookTransferExtras(args.mint) : [])],
    data: Buffer.from(data),
  });
}

/** DAMM v2 pool token vault: `["token_vault", mint, pool]` under the DAMM v2 program. */
export function dammV2VaultAddress(mint: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("token_vault"), mint.toBytes(), pool.toBytes()], PROGRAM_IDS.dammV2)[0];
}

/** The owner's canonical wSOL account (SPL Token). */
export const wsolAta = (owner: PublicKey): PublicKey => associatedTokenAddress(owner, WSOL_MINT, KNOWN_ACCOUNTS.splToken);
/** The owner's canonical account for a Noised (Token-2022) mint. */
export const t22Ata = (owner: PublicKey, mint: PublicKey): PublicKey => associatedTokenAddress(owner, mint, KNOWN_ACCOUNTS.token2022);

/**
 * Instruction assembly from an IDL: account order, writability and signer
 * flags come from the IDL's account list (generated from the program's
 * `#[derive(Accounts)]` struct), so a builder cannot reorder or mis-flag an
 * account. Fixed addresses in the IDL are enforced. Absent optional accounts
 * become the program id (read-only), exactly like Anchor's Rust client.
 */
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { Buffer } from "buffer";

import { camelCase, type IdlCodec } from "./idl.js";

export type IxAccounts = Record<string, PublicKey | null | undefined>;

export function buildInstruction(
  codec: IdlCodec,
  programId: PublicKey,
  name: string,
  accounts: IxAccounts,
  args: Record<string, unknown> = {},
  remaining: readonly AccountMeta[] = [],
): TransactionInstruction {
  if (codec.idl.address !== programId.toBase58()) {
    throw new Error(`${codec.name}: IDL address ${codec.idl.address} does not match program ${programId.toBase58()}`);
  }
  const ix = codec.instruction(name);
  const used = new Set<string>();
  const keys: AccountMeta[] = [];
  for (const acc of ix.accounts) {
    if (acc.accounts !== undefined) throw new Error(`${codec.name}.${name}: nested account groups are not supported`);
    const key = camelCase(acc.name);
    used.add(key);
    const given = accounts[key];
    let pubkey: PublicKey;
    if (acc.address !== undefined) {
      const fixed = new PublicKey(acc.address);
      if (given !== undefined && given !== null && !given.equals(fixed)) {
        throw new Error(`${codec.name}.${name}: account ${key} must be ${acc.address}, got ${given.toBase58()}`);
      }
      pubkey = fixed;
    } else if (given === null) {
      if (acc.optional !== true) throw new Error(`${codec.name}.${name}: account ${key} is required`);
      keys.push({ pubkey: programId, isSigner: false, isWritable: false });
      continue;
    } else if (given === undefined) {
      throw new Error(`${codec.name}.${name}: missing account ${key}`);
    } else {
      pubkey = given;
    }
    keys.push({ pubkey, isSigner: acc.signer === true, isWritable: acc.writable === true });
  }
  const unknown = Object.keys(accounts).filter((k) => !used.has(k));
  if (unknown.length > 0) throw new Error(`${codec.name}.${name}: unknown account(s) ${unknown.join(", ")}`);
  for (const r of remaining) keys.push({ pubkey: r.pubkey, isSigner: r.isSigner, isWritable: r.isWritable });
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(codec.encodeInstruction(name, args)),
  });
}

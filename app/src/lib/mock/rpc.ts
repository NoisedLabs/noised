/** MOCK read helpers (SPEC §4.1 "rpc helpers": SOL and token balance reads) and demo controls. */
import type { Connection, PublicKey } from "@solana/web3.js";

import type { MintInfo } from "../backend/types";
import { chain, ensureFunded } from "./chain";
import { DEMO_MINTS, mockMint, toMintInfo } from "./mints";
import { latency, solBalance, tokenBalance } from "./store";

export async function getSolBalance(_conn: Connection, owner: PublicKey): Promise<bigint> {
  await latency("read");
  return solBalance(chain(), owner);
}

/** Balance of `owner`'s canonical (associated) token account for `mint`; 0 if it does not exist. */
export async function getTokenBalance(_conn: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  await latency("read");
  return tokenBalance(chain(), owner, mint);
}

export async function getTokenSupply(_conn: Connection, mint: PublicKey): Promise<bigint> {
  await latency("read");
  return mockMint(chain(), mint)?.supply ?? 0n;
}

/** Owner program, decimals and supply of a mint; null if the account is not a mint. */
export async function getMintInfo(_conn: Connection, mint: PublicKey): Promise<MintInfo | null> {
  await latency("read");
  const m = mockMint(chain(), mint);
  return m ? toMintInfo(m) : null;
}

/** Mock only: give a wallet demo balances (25 SOL, tokens, commits in two batches) the first time it is seen. */
export function fundDemoWallet(owner: PublicKey): void {
  ensureFunded(owner);
}

/** Mock only: mints that exercise every branch of the vault's mint policy. */
export function demoMints(): MintInfo[] {
  return DEMO_MINTS.map(toMintInfo);
}

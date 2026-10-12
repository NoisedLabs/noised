/**
 * MOCK account lookup: what kind of account the simulated chain holds at an
 * address (its owner program, whether it is executable or holds data), as an
 * RPC's `getAccountInfo` would tell the SDK. Shared by the recipient checks
 * (vault payouts, commit payout owners, swap recipients).
 */
import { associatedTokenAddress, KNOWN_ACCOUNTS, PROGRAM_IDS } from "@noisedlabs/sdk";
import { PublicKey } from "@solana/web3.js";

import { mockMint } from "./mints";
import type { MockState } from "./store";

const SPL = KNOWN_ACCOUNTS.splToken;
const T22 = KNOWN_ACCOUNTS.token2022;

/** Executable accounts of the simulated chain: the programs a Noised transaction can name. */
export const PROGRAMS: readonly PublicKey[] = [
  ...Object.values(PROGRAM_IDS),
  KNOWN_ACCOUNTS.system,
  SPL,
  T22,
  KNOWN_ACCOUNTS.associatedToken,
  KNOWN_ACCOUNTS.computeBudget,
  KNOWN_ACCOUNTS.memo,
  KNOWN_ACCOUNTS.bpfLoaderUpgradeable,
];

/** The owner of `account` if it is the canonical token account of a (owner, mint) the simulated chain knows. */
export function ownerOfTokenAccount(s: MockState, account: PublicKey, mint: PublicKey | null): { owner: PublicKey; mint: PublicKey } | null {
  for (const key of Object.keys(s.tokens)) {
    const [ownerText, mintText] = key.split(":");
    if (ownerText === undefined || mintText === undefined) continue;
    if (mint !== null && mintText !== mint.toBase58()) continue;
    const m = new PublicKey(mintText);
    const tokenProgram = mockMint(s, m)?.tokenProgram;
    if (tokenProgram === undefined) continue;
    const owner = new PublicKey(ownerText);
    if (associatedTokenAddress(owner, m, tokenProgram).equals(account)) return { owner, mint: m };
  }
  return null;
}

/** The account the simulated chain holds at `address` (its owner program; programs are executable), or null when it holds none. */
export function accountAt(s: MockState, address: PublicKey): { owner: PublicKey; executable: boolean; hasData: boolean } | null {
  const id = address.toBase58();
  if (PROGRAMS.some((p) => p.equals(address))) return { owner: KNOWN_ACCOUNTS.bpfLoaderUpgradeable, executable: true, hasData: true };
  const asMint = mockMint(s, address);
  if (asMint) return { owner: asMint.tokenProgram, executable: false, hasData: true };
  const asTokenAccount = ownerOfTokenAccount(s, address, null);
  if (asTokenAccount) return { owner: mockMint(s, asTokenAccount.mint)?.tokenProgram ?? SPL, executable: false, hasData: true };
  if (s.vaults[id] || s.payouts[id]) return { owner: PROGRAM_IDS.vault, executable: false, hasData: true };
  if (s.launches[id] || s.attestations[id] || s.tokenMetas[id] || s.identities[id] || Object.values(s.commits).some((c) => c.publicKey.equals(address))) return { owner: PROGRAM_IDS.launchpad, executable: false, hasData: true };
  for (const l of Object.values(s.launches)) {
    if (l.state.pool.equals(address) || l.state.dbcConfig.equals(address)) return { owner: PROGRAM_IDS.dbc, executable: false, hasData: true };
    if (l.dammPool?.equals(address) === true) return { owner: PROGRAM_IDS.dammV2, executable: false, hasData: true };
  }
  if (Object.values(s.shields).some((x) => x.account.publicKey.equals(address))) return { owner: PROGRAM_IDS.shield, executable: false, hasData: true };
  if (s.sol[id] !== undefined) return { owner: KNOWN_ACCOUNTS.system, executable: false, hasData: false };
  return null;
}

/** The mint of a PQ vault the simulated chain holds at `address` (the launchpad's `pq::is_vault_of`), or null when it is not a vault. */
export function vaultMintAt(s: MockState, address: PublicKey): PublicKey | null {
  return s.vaults[address.toBase58()]?.mint ?? null;
}

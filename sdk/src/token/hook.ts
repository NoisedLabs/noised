/**
 * Transfer-hook account resolution for transfers that our programs make by
 * CPI (vault release / release_to, shield wrap / unwrap, launchpad claims and
 * the batch swap) and for DBC swaps.
 *
 * The vault and the shield forward their remaining accounts to
 * `spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi`,
 * which looks every account up by key: the hook program (always required
 * when the mint has a hook), the mint's validation account (when it exists)
 * and every extra account it resolves. Token-2022 then re-derives and checks
 * them, so a wrong list can only fail, never redirect funds. The launchpad
 * additionally requires exactly the canonical list, in order
 * (`hook_accounts::validate`).
 *
 * A Noised-hooked mint (the Launch Guard) has four hook accounts: its meta
 * list, the policy PDA `["policy", mint]`, the instructions sysvar (read to
 * tell the batch buy from other buys during the snipe shield) and the hook
 * program. Generic hooks are resolved through `@solana/spl-token`.
 */
import { addExtraAccountMetasForExecute, createTransferCheckedInstruction } from "@solana/spl-token";
import { PublicKey, type AccountMeta, type Commitment, type Connection } from "@solana/web3.js";

import { HOOK_ERRORS, KNOWN_ACCOUNTS, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { extraAccountMetaListAddress, hookPolicyAddress } from "../pda.js";
import { getAccount, ownedBy } from "../rpc/fetch.js";
import { transferHookOf, type ParsedMint } from "./mint.js";

export interface HookTransfer {
  source: PublicKey;
  destination: PublicKey;
  /** Owner or delegate of `source` (the signer of the transfer). */
  authority: PublicKey;
  amount: bigint;
}

/**
 * Order of the hook accounts:
 * - `launchpad`: `[meta list, policy, instructions sysvar, hook program]`,
 *   the launchpad's canonical order (`hook_accounts::expected`);
 * - `resolver`: the order the transfer-hook interface's off-chain resolver
 *   appends them (`@solana/spl-token`'s `addExtraAccountMetasForExecute`,
 *   `spl_transfer_hook_interface::offchain`): the meta list's extra accounts,
 *   then the hook program, then the meta list. The vault builders use it, so
 *   their transactions are byte-identical with the Rust reference client
 *   (tests/integration `sdk_vectors.rs`).
 * Both work wherever accounts are looked up by key (vault, shield, DBC).
 */
export type HookAccountOrder = "launchpad" | "resolver";

const meta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/** The active transfer-hook program of a parsed mint, or null. */
export function activeHookProgram(mint: ParsedMint): PublicKey | null {
  if (!mint.programId.equals(KNOWN_ACCOUNTS.token2022)) return null;
  return transferHookOf(mint)?.programId ?? null;
}

/**
 * The end of `mint`'s Launch Guard (`guard_end_ts`, unix seconds) from its
 * live policy, when the mint's active transfer hook is Noised's and the
 * policy exists; null otherwise (no hook, another hook, or the hook revoked
 * at graduation). Throws when the policy names another mint.
 */
export async function launchGuardEndTs(conn: Connection, mint: PublicKey, parsed: ParsedMint): Promise<bigint | null> {
  const hook = activeHookProgram(parsed);
  if (hook === null || !hook.equals(PROGRAM_IDS.hook)) return null;
  const acc = ownedBy(await getAccount(conn, hookPolicyAddress(mint)), PROGRAM_IDS.hook, "Launch Guard policy");
  if (acc === null) return null;
  const p = idlCodecs().hook.decodeAccount<{ mint: PublicKey; guardEndTs: bigint }>("HookPolicy", acc.data);
  if (!p.mint.equals(mint)) throw new Error("the Launch Guard policy belongs to another mint");
  return p.guardEndTs;
}

/**
 * Why a transfer into a token account without `ImmutableOwner` is refused
 * while the Launch Guard is on (`MutableOwner`, 6010, audit round 3 F2):
 * whoever could reassign that account's owner could hand the tokens over
 * without a transfer, around the guard's wallet-to-wallet lock and max-wallet
 * cap. Sells are never refused.
 */
export function mutableOwnerRefusal(guardEndTs: bigint): string {
  const until = new Date(Number(guardEndTs) * 1000).toISOString();
  return `its owner can be reassigned (no ImmutableOwner extension), and until ${until} the Launch Guard only lets tokens into accounts whose owner is fixed (MutableOwner ${HOOK_ERRORS.MutableOwner}): receive into the owner's associated token account (every Token-2022 associated token account has a fixed owner), or wait until the guard ends`;
}

/**
 * The Launch Guard's four accounts for `mint`, read-only, in the launchpad's
 * canonical order `[extra_account_meta_list, policy, instructions sysvar,
 * noised_hook]` (`execute_batch` and `claim` require exactly this list).
 */
export function noisedHookAccounts(mint: PublicKey, order: HookAccountOrder = "launchpad"): AccountMeta[] {
  const list = extraAccountMetaListAddress(mint);
  const policy = hookPolicyAddress(mint);
  return order === "launchpad"
    ? [meta(list), meta(policy), meta(KNOWN_ACCOUNTS.sysvarInstructions), meta(PROGRAM_IDS.hook)]
    : [meta(policy), meta(KNOWN_ACCOUNTS.sysvarInstructions), meta(PROGRAM_IDS.hook), meta(list)];
}

/**
 * Remaining accounts for CPI transfers of `mint`: the union (by key) of what
 * each transfer resolves to, plus the hook program. Empty when the mint has
 * no active hook. Never marks an account as signer. A Launch Guard mint gets
 * its fixed four accounts without RPC round trips (`verifyLaunch` checks
 * that its meta list holds exactly the two canonical metas).
 */
export async function resolveHookAccounts(
  conn: Connection,
  mintAddress: PublicKey,
  mint: ParsedMint,
  transfers: readonly HookTransfer[],
  commitment: Commitment = "confirmed",
  order: HookAccountOrder = "launchpad",
): Promise<AccountMeta[]> {
  const hookProgram = activeHookProgram(mint);
  if (hookProgram === null) return [];
  if (hookProgram.equals(PROGRAM_IDS.hook)) return noisedHookAccounts(mintAddress, order);
  const merged = new Map<string, AccountMeta>();
  const add = (m: AccountMeta): void => {
    const id = m.pubkey.toBase58();
    const prev = merged.get(id);
    if (prev) prev.isWritable ||= m.isWritable;
    else merged.set(id, { pubkey: m.pubkey, isSigner: false, isWritable: m.isWritable });
  };
  for (const t of transfers) {
    const ix = createTransferCheckedInstruction(t.source, mintAddress, t.destination, t.authority, t.amount, mint.decimals, [], KNOWN_ACCOUNTS.token2022);
    const base = ix.keys.length;
    await addExtraAccountMetasForExecute(conn, ix, hookProgram, t.source, mintAddress, t.destination, t.authority, t.amount, commitment);
    for (const k of ix.keys.slice(base)) add(k);
  }
  // Required even when the mint has no validation account.
  add({ pubkey: hookProgram, isSigner: false, isWritable: false });
  return [...merged.values()];
}

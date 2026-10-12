/**
 * Who may receive launch payouts: fee recipients (`distribute` pays
 * ATA(wallet, wSOL)), a commit's payout owners (`claim` pays ATA(token
 * owner, base mint) and ATA(refund owner, wSOL)) and a swap's recipient (the
 * AMM pays the output token account the transaction names).
 *
 * Each of these pays the canonical associated token account of an owner
 * address, which works for any owner, on or off the Ed25519 curve. Nothing
 * on-chain asks whether that owner can ever move the tokens, so the SDK
 * refuses owners that never can: token accounts and mints, PQ vaults of
 * another mint (a vault only releases its own mint), other accounts of the
 * vault program (payouts), and off-curve addresses with no account (an
 * unopened vault, a closed account or a mistyped program address).
 *
 * A PQ vault is recognized exactly as the launchpad does (`pq::is_vault_of`):
 * owned by the vault program, the `Vault` discriminator, version 4 and the
 * mint at bytes 10..42. Its canonical ATA is the vault's own token account,
 * which only the vault's hash-based signature can move.
 */
import { PublicKey, type Connection } from "@solana/web3.js";

import { bytesEqual } from "../codec/bytes.js";
import { KNOWN_ACCOUNTS, PQ_VAULT_LAYOUT, PROGRAM_IDS, WSOL_MINT } from "../constants.js";
import { associatedTokenAddress, autopilotTreasuryAddress } from "../pda.js";
import { getAccount, getAccounts, type RawAccount } from "../rpc/fetch.js";
import type { FeeRecipient } from "../types.js";

/**
 * Whether `acc` is a Noised PQ vault of `mint`, byte for byte as the
 * launchpad recognizes one: owner = the vault program, data starts with the
 * `Vault` discriminator, version 4 at byte 8, `mint` at bytes 10..42.
 */
export function isPqVaultOf(acc: Pick<RawAccount, "owner" | "data"> | null, mint: PublicKey): boolean {
  if (acc === null || !acc.owner.equals(PROGRAM_IDS.vault)) return false;
  const d = acc.data;
  const mintEnd = PQ_VAULT_LAYOUT.MINT_OFFSET + 32;
  return (
    d.length >= mintEnd &&
    bytesEqual(d.subarray(0, 8), Uint8Array.from(PQ_VAULT_LAYOUT.DISCRIMINATOR)) &&
    d[PQ_VAULT_LAYOUT.VERSION_OFFSET] === PQ_VAULT_LAYOUT.VERSION &&
    bytesEqual(d.subarray(PQ_VAULT_LAYOUT.MINT_OFFSET, mintEnd), mint.toBytes())
  );
}

/** The mint a PQ vault account holds (null if `acc` is not a v4 vault). */
export function pqVaultMint(acc: Pick<RawAccount, "owner" | "data"> | null): PublicKey | null {
  if (acc === null || !acc.owner.equals(PROGRAM_IDS.vault)) return null;
  const mint = new PublicKey(acc.data.length >= PQ_VAULT_LAYOUT.MINT_OFFSET + 32 ? acc.data.subarray(PQ_VAULT_LAYOUT.MINT_OFFSET, PQ_VAULT_LAYOUT.MINT_OFFSET + 32) : new Uint8Array(32));
  return isPqVaultOf(acc, mint) ? mint : null;
}

/** What kind of owner a token recipient is. */
export type TokenRecipientKind = "wallet" | "pq-vault" | "program-account";

export interface TokenRecipientCheck {
  /** No refusal. */
  ok: boolean;
  /** `wallet`: an Ed25519 key (on the curve); `pq-vault`: a PQ vault of this mint; `program-account`: an off-curve account of another program. Null when refused. */
  kind: TokenRecipientKind | null;
  /** Reasons the tokens would be lost or stranded. Never pay while there is one. */
  refusals: string[];
  /** Cautions to show (they do not lose the tokens). */
  warnings: string[];
  /** Where the tokens go: the canonical ATA of `recipient` for `mint`. */
  ata: PublicKey;
}

/**
 * Whether paying ATA(`recipient`, `mint`) can strand the tokens. `account`
 * is the recipient's account if already fetched (`undefined`: fetch it).
 */
export async function checkTokenRecipient(
  conn: Connection,
  recipient: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  account?: RawAccount | null,
): Promise<TokenRecipientCheck> {
  const ata = associatedTokenAddress(recipient, mint, tokenProgram);
  const refusals: string[] = [];
  const warnings: string[] = [];
  const done = (kind: TokenRecipientKind | null): TokenRecipientCheck => ({ ok: refusals.length === 0, kind: refusals.length === 0 ? kind : null, refusals, warnings, ata });
  if (recipient.equals(PublicKey.default)) {
    refusals.push("the all-zero address is nobody's");
    return done(null);
  }
  const acc = account === undefined ? await getAccount(conn, recipient) : account;
  // Any account, even lamports only (a multisig's vault is a system-owned PDA).
  const exists = acc !== null;
  if (acc !== null && acc.owner.equals(PROGRAM_IDS.vault)) {
    if (isPqVaultOf(acc, mint)) return done("pq-vault");
    const other = pqVaultMint(acc);
    refusals.push(
      other === null
        ? "an account of the PQ vault program that is not a vault (a payout or an old vault version): nothing can ever move tokens sent to it"
        : `a PQ vault of another mint (${other.toBase58()}): a vault only releases its own mint, so these tokens would be stuck forever`,
    );
    return done(null);
  }
  if (acc !== null && (acc.owner.equals(KNOWN_ACCOUNTS.splToken) || acc.owner.equals(KNOWN_ACCOUNTS.token2022))) {
    refusals.push("a token account or mint is not a wallet: its own associated token account can never be moved");
    return done(null);
  }
  if (PublicKey.isOnCurve(recipient.toBytes())) {
    if (acc !== null && acc.executable) refusals.push("a program is not a wallet");
    return done("wallet");
  }
  if (!exists) {
    refusals.push(
      "an off-curve address with no account: an unopened vault, a closed account or a mistyped program address. Nobody holds a key for it; open the vault first, or name a wallet",
    );
    return done(null);
  }
  if (acc !== null && acc.executable) {
    refusals.push("a program is not a wallet");
    return done(null);
  }
  warnings.push(
    `an off-curve account of ${acc!.owner.equals(KNOWN_ACCOUNTS.system) ? "the system program (a program wallet, e.g. a multisig vault)" : `program ${acc!.owner.toBase58()}`}: only that program can move what its token account receives`,
  );
  return done("program-account");
}

/** `checkFeeRecipients`' verdict: every refusal and warning as `"recipients[i].wallet: ..."`. */
export interface FeeRecipientsCheck {
  /** No refusal. */
  ok: boolean;
  refusals: string[];
  warnings: string[];
}

/**
 * Fee recipients as `distribute` will pay them (ATA(wallet, wSOL)), checked
 * against the cluster (`checkTokenRecipient` for wSOL; audit round 3 F3):
 * refused are a PQ vault of another mint (a vault only ever moves its own
 * mint, so the wSOL share sent to it would be lost for good) and any other
 * account of the vault program, token accounts and mints, programs and
 * off-curve addresses with no account; an account of another program is a
 * warning (only that program can move what its token account receives).
 * The identity attests the parameters, so check before `create_launch`:
 * `buildCreateLaunchTx` runs this, and a wizard can run it as each
 * recipient is entered. `accounts`: the recipients' accounts if already
 * fetched, in order.
 */
export async function checkFeeRecipients(
  conn: Connection,
  recipients: readonly Pick<FeeRecipient, "wallet">[],
  accounts?: readonly (RawAccount | null | undefined)[],
  opts: { readonly launch?: PublicKey | undefined } = {},
): Promise<FeeRecipientsCheck> {
  for (const r of recipients) if (r === null || typeof r !== "object" || !(r.wallet instanceof PublicKey)) throw new TypeError("every recipient needs a wallet PublicKey");
  const fetched = accounts ?? (await getAccounts(conn, recipients.map((r) => r.wallet)));
  const refusals: string[] = [];
  const warnings: string[] = [];
  // The launch's own autopilot treasury (`["treasury", launch]`, P1c quick launch): an off-curve PDA with no account of
  // its own, whose wSOL account `distribute` (or `init_autopilot`) creates; only the autopilot program moves it.
  const treasury = opts.launch === undefined ? null : autopilotTreasuryAddress(opts.launch);
  for (const [i, r] of recipients.entries()) {
    if (treasury !== null && r.wallet.equals(treasury)) {
      warnings.push(
        `recipients[${i}].wallet: the launch's autopilot treasury: only an autopilot graph the launch's post-quantum identity activates can spend it (buy back and burn, burn, or pay the graph's recipients); until one is active the fees stay there`,
      );
      continue;
    }
    const c = await checkTokenRecipient(conn, r.wallet, WSOL_MINT, KNOWN_ACCOUNTS.splToken, fetched[i] ?? null);
    for (const reason of c.refusals) refusals.push(`recipients[${i}].wallet: ${reason}`);
    for (const w of c.warnings) warnings.push(`recipients[${i}].wallet: ${w}`);
  }
  return { ok: refusals.length === 0, refusals, warnings };
}

/** `checkGraphRecipients`' verdict: `FeeRecipientsCheck` plus the recipients that cannot receive a share yet. */
export interface GraphRecipientsCheck extends FeeRecipientsCheck {
  /**
   * Recipients (owners) without a wSOL account at their canonical address
   * yet: the autopilot skips them and their share stays in the treasury
   * until they create one (audit 4, M4: a keeper never pays for it). Also
   * listed in `warnings`.
   */
  readonly withoutAccount: PublicKey[];
}

/**
 * An autopilot graph's DISTRIBUTE_SOL recipients, checked exactly like fee
 * recipients (audit 4, C1): `run` pays ATA(recipient, wSOL), so a PQ vault of
 * another mint (it only ever releases its own mint: the share would be lost
 * for good), any other account of the vault program, token accounts and
 * mints, programs and off-curve addresses with no account are refused, and
 * an account of another program is a warning (only that program can move
 * what its token account receives). A recipient whose wSOL account does not
 * exist yet is a warning too (`withoutAccount`: skipped, its share kept, until
 * it creates one). Refusals and warnings read `"recipients[i] (address): ..."`.
 * `recipients`: the graph's recipient addresses in order (`Graph.recipients`
 * or the PXG1 recipients).
 */
export async function checkGraphRecipients(conn: Connection, recipients: readonly PublicKey[]): Promise<GraphRecipientsCheck> {
  for (const r of recipients) if (!(r instanceof PublicKey)) throw new TypeError("every graph recipient must be a PublicKey");
  const wsolAtas = recipients.map((r) => associatedTokenAddress(r, WSOL_MINT, KNOWN_ACCOUNTS.splToken));
  const fetched = recipients.length === 0 ? [] : await getAccounts(conn, [...recipients, ...wsolAtas]);
  const refusals: string[] = [];
  const warnings: string[] = [];
  const withoutAccount: PublicKey[] = [];
  for (const [i, r] of recipients.entries()) {
    const label = `recipients[${i}] (${r.toBase58()})`;
    const c = await checkTokenRecipient(conn, r, WSOL_MINT, KNOWN_ACCOUNTS.splToken, fetched[i] ?? null);
    for (const reason of c.refusals) refusals.push(`${label}: ${reason}`);
    for (const w of c.warnings) warnings.push(`${label}: ${w}`);
    if (c.ok && (fetched[recipients.length + i] ?? null) === null) {
      withoutAccount.push(r);
      warnings.push(
        `${label}: has no wSOL account yet: until it creates one, the autopilot skips it and its share stays in the treasury (keepers never pay to create it)`,
      );
    }
  }
  return { ok: refusals.length === 0, refusals, warnings, withoutAccount };
}

/**
 * Key records between devices: one file that carries this browser's records
 * of which one-time keys already signed (vault keys, and the leaves of the
 * launch identity), for another device that holds the same quantum key.
 *
 * A device that does not know a key was used could sign a second message
 * with it, and two signatures of one one-time key can be forged. So, before
 * a device signs with a key another device may have used, it imports the
 * other device's records. Both halves use the SDK's authenticated import:
 * every record must verify (its signature under its key over its message)
 * before anything is written, an import only adds (it never frees a key),
 * and conflicts (a key used for two messages) are reported. Keys the other
 * device signed with but could not include (`unverifiable`) stop all vault
 * signing here until a complete file is imported (lib/ledger.ts).
 *
 * The file holds public data only (keys, messages, signatures): no secret.
 */
import { PublicKey } from "@solana/web3.js";

import { addUnverifiableKeys, type BrowserLedgers } from "./ledger";
import {
  completeVaultKeyRecords,
  exportVaultKeyRecords,
  importVaultKeyRecords,
  leafLedger,
  parseWithdrawMessage,
  LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT,
  VAULT_KEY_LEDGER_EXPORT_FORMAT,
  type Cluster,
  type LeafLedgerExport,
  type PqIdentity,
  type VaultKeyImportSummary,
  type VaultKeyLedgerExport,
} from "./noised";
import { decodeHex } from "./storage";

/** Format tag of the file. */
export const KEY_RECORDS_FORMAT = "noised/app/key-records/v1";
/** The same format as saved before the rename to Noised (still imported, with its earlier vault-key format tag). */
export const LEGACY_KEY_RECORDS_FORMAT = "phalanx/app/key-records/v1";

export interface KeyRecordsFile {
  format: typeof KEY_RECORDS_FORMAT | typeof LEGACY_KEY_RECORDS_FORMAT;
  /** The cluster the records are for: keys are derived per cluster. */
  cluster: Cluster;
  createdAt: number;
  vaultKeys: VaultKeyLedgerExport;
  /** One entry per launch identity of the quantum key (when it was unlocked at export). */
  leaves: LeafLedgerExport[];
}

export interface ExportResult {
  text: string;
  /** Signed vault-key records that could not be included (no key on file): the other device will refuse to sign until they are. */
  missingKeys: number;
  vaultRecords: number;
  leafRecords: number;
}

/**
 * The records of this browser, ready to save as a file. With the quantum
 * key unlocked (`master`), signed records that lack their one-time key get
 * it first (`completeVaultKeyRecords`, for the mints they name), so the
 * file can carry them; and the launch identity's leaf records are included.
 */
export async function exportKeyRecords(
  ledgers: Pick<BrowserLedgers, "vaultKeys" | "leaves">,
  opts: { cluster: Cluster; master: Uint8Array | null; identity: PqIdentity | null; maxAccount?: number },
): Promise<ExportResult> {
  let vaultKeys = await exportVaultKeyRecords(ledgers.vaultKeys);
  const noKey = vaultKeys.skipped.filter((s) => s.reason === "no-key");
  if (noKey.length > 0 && opts.master !== null) {
    const mints = new Set<string>();
    for (const r of await ledgers.vaultKeys.list()) {
      if (r.key !== null || r.signature === null) continue;
      try {
        mints.add(parseWithdrawMessage(decodeHex(r.message)).mint.toBase58());
      } catch {
        // Unreadable message: it stays skipped.
      }
    }
    for (const m of mints) await completeVaultKeyRecords(ledgers.vaultKeys, opts.master, opts.cluster, new PublicKey(m), opts.maxAccount ?? 64);
    vaultKeys = await exportVaultKeyRecords(ledgers.vaultKeys);
  }
  const leaves: LeafLedgerExport[] = [];
  if (opts.identity !== null) {
    const exported = await leafLedger.exportLeafRecords(ledgers.leaves, opts.identity.identityId);
    if (exported.records.length > 0) leaves.push(exported);
  }
  const file: KeyRecordsFile = { format: KEY_RECORDS_FORMAT, cluster: opts.cluster, createdAt: Date.now(), vaultKeys, leaves };
  return {
    text: JSON.stringify(file, null, 2),
    missingKeys: vaultKeys.skipped.filter((s) => s.reason === "no-key").length,
    vaultRecords: vaultKeys.records.length,
    leafRecords: leaves.reduce((n, l) => n + l.records.length, 0),
  };
}

export interface ImportReport {
  vault: VaultKeyImportSummary;
  /** Leaf records imported per identity (hex id), or why they were not. */
  leaves: { identityId: string; added: number; merged: number; conflicts: number[]; compromised: number[] }[];
  /** Identities in the file whose records were not imported: unlock the quantum key that owns them first. */
  leavesSkipped: string[];
}

function parseFile(text: string, cluster: Cluster): KeyRecordsFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not a key records file (not JSON).");
  }
  if (typeof v !== "object" || v === null) throw new Error("This is not a key records file.");
  const o = v as Partial<KeyRecordsFile>;
  if (o.format !== KEY_RECORDS_FORMAT && o.format !== LEGACY_KEY_RECORDS_FORMAT) throw new Error("This is not a Noised key records file.");
  if (o.cluster !== cluster) throw new Error(`These records are for ${String(o.cluster)}; this app is built for ${cluster}. Nothing was imported.`);
  if (typeof o.vaultKeys !== "object" || o.vaultKeys === null || (o.vaultKeys.format !== VAULT_KEY_LEDGER_EXPORT_FORMAT && o.vaultKeys.format !== LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT)) throw new Error("The file's vault key records are missing.");
  if (!Array.isArray(o.leaves)) throw new Error("The file's launch key records are missing.");
  return o as KeyRecordsFile;
}

/**
 * Import another device's file. The vault-key records are authenticated as
 * a whole (nothing is written if one fails); keys the other device could
 * not include are remembered and stop vault signing here. Leaf records are
 * imported for the unlocked identity only (they authenticate against its
 * public key); others are listed in `leavesSkipped`.
 */
export async function importKeyRecords(ledgers: Pick<BrowserLedgers, "vaultKeys" | "leaves" | "meta">, text: string, opts: { cluster: Cluster; identity: PqIdentity | null }): Promise<ImportReport> {
  const file = parseFile(text, opts.cluster);
  const vault = await importVaultKeyRecords(ledgers.vaultKeys, file.vaultKeys);
  await addUnverifiableKeys(ledgers, vault.unverifiable);
  const leaves: ImportReport["leaves"] = [];
  const leavesSkipped: string[] = [];
  const mine = opts.identity === null ? null : Array.from(opts.identity.identityId, (b) => b.toString(16).padStart(2, "0")).join("");
  for (const l of file.leaves) {
    if (opts.identity === null || l.identityId.toLowerCase() !== mine) {
      leavesSkipped.push(l.identityId);
      continue;
    }
    const s = await leafLedger.importLeafRecords(ledgers.leaves, opts.identity.publicKey, l);
    leaves.push({ identityId: l.identityId, added: s.added, merged: s.merged, conflicts: s.conflicts, compromised: s.compromised });
  }
  return { vault, leaves, leavesSkipped };
}

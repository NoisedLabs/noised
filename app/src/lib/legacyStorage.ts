/**
 * Web Storage of the project's earlier name (the rename to Noised), migrated once per browser profile.
 *
 * Every localStorage key `phalanx.<rest>` is copied to `noised.<rest>` when that key is free (never overwriting),
 * before anything reads the renamed keys: this module runs its migration when it is first imported (main.tsx imports
 * it first; lib/storage.ts and lib/pqKey.ts import it too). It covers the preferences, the passkey list, the demo's
 * simulated chain and, above all, the signed vault withdrawals and signing claims (lib/storage.ts): those must keep
 * blocking their one-time keys, so nothing is ever deleted (the earlier keys stay, unread, as a backup), and a run
 * that could not copy everything is retried on the next page load (the flag is set only after every copy is read
 * back; a profile without any earlier key writes nothing). The one-time keys themselves are bound by the IndexedDB
 * ledgers (lib/ledger.ts), migrated separately.
 */

/** Prefix of every key this app writes. */
export const STORAGE_PREFIX = "noised.";
/** The same prefix before the rename (read once, by the migration only). */
export const LEGACY_STORAGE_PREFIX = "phalanx.";
/** Set once every earlier key has been copied (or already had a value under its new name). */
export const STORAGE_MIGRATED_KEY = "noised.storage-migration.v1";

/** The part of Web Storage the migration uses. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What `migrateLegacyStorage` did (null: no storage, or it already ran in this profile). */
export interface StorageMigration {
  copied: number;
  /** Keys whose new name already held a value (left as it is). */
  alreadyThere: number;
  /** Keys that could not be copied (storage full or blocked): retried on the next load. */
  failed: number;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Copy every `phalanx.*` key to its `noised.*` name, once (see the module docs). Never throws. */
export function migrateLegacyStorage(storage: StorageLike | null = defaultStorage()): StorageMigration | null {
  if (storage === null) return null;
  try {
    if (storage.getItem(STORAGE_MIGRATED_KEY) !== null) return null;
    const legacy: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      // `phalanx.probe.*` were transient write probes (lib/storage.ts `storageWorks`).
      if (k !== null && k.startsWith(LEGACY_STORAGE_PREFIX) && !k.startsWith(`${LEGACY_STORAGE_PREFIX}probe.`)) legacy.push(k);
    }
    const out: StorageMigration = { copied: 0, alreadyThere: 0, failed: 0 };
    if (legacy.length === 0) return out; // nothing of the earlier name here: nothing written
    for (const k of legacy) {
      const value = storage.getItem(k);
      if (value === null) continue;
      const target = STORAGE_PREFIX + k.slice(LEGACY_STORAGE_PREFIX.length);
      if (storage.getItem(target) !== null) {
        out.alreadyThere++;
        continue;
      }
      try {
        storage.setItem(target, value);
        if (storage.getItem(target) === value) out.copied++;
        else out.failed++;
      } catch {
        out.failed++;
      }
    }
    if (out.failed === 0) storage.setItem(STORAGE_MIGRATED_KEY, JSON.stringify({ at: Date.now(), copied: out.copied, alreadyThere: out.alreadyThere }));
    return out;
  } catch {
    return null;
  }
}

/** The migration's result in this page (run when this module was first imported). */
export const storageMigration: StorageMigration | null = migrateLegacyStorage();

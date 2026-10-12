/**
 * Ledger records written under the project's earlier name (migration for the
 * rename to Noised). Internal: not exported from the package root except
 * `migrateLegacyLedgerRecords`.
 *
 * The ledgers keep their records under `noised/pq/...` keys. Earlier releases
 * (`@phalanx/sdk` 0.9.0 and older) kept the same records, in the same JSON
 * format, under `phalanx/pq/...` keys. Such a record still binds its one-time
 * key to its message forever: losing it could let the key sign a second
 * message, and anyone holding both signatures could forge at that key. A
 * client of the earlier release may also still run on the same store (an
 * open tab, a second process). So every ledger reads its store through
 * `withLegacyNamespace`:
 *
 * 1. Before its first operation, every record under the legacy namespace is
 *    copied to its new key with `add` (never overwriting a record there).
 * 2. A read that finds nothing under the new key reads the legacy key, and
 *    copies a record found there forward (`add`) before returning it, so
 *    records an earlier client writes later are honoured too.
 * 3. `keys` lists both namespaces (legacy keys under their new names).
 * 4. `add`, the atomic reservation, claims the legacy key first (the
 *    primitive earlier clients reserve with), then the new key. Whichever
 *    client reserves a key first, under either name, holds it, and the other
 *    is refused: no one-time key is given to two messages across the rename.
 *
 * Legacy keys are never deleted and never `put`. The ledgers also take the
 * legacy lock name around their own (same order everywhere: no deadlock).
 * Drop this module once no client of the earlier name can share a store with
 * this one.
 */
import type { LedgerLock } from "./ledgerLock.js";
import type { LeafLedgerStore } from "./leafLedger.js";

/** Key prefix of every ledger record, store key and lock name of this release. */
export const NAME_PREFIX = "noised/";
/** The same prefix before the rename (migration only: records and locks of earlier clients). */
export const LEGACY_NAME_PREFIX = "phalanx/";

/** `noised/...` -> `phalanx/...` (any other name is returned unchanged). */
export function legacyName(name: string): string {
  return name.startsWith(NAME_PREFIX) ? LEGACY_NAME_PREFIX + name.slice(NAME_PREFIX.length) : name;
}

/** `phalanx/...` -> `noised/...` (any other name is returned unchanged). */
export function currentName(name: string): string {
  return name.startsWith(LEGACY_NAME_PREFIX) ? NAME_PREFIX + name.slice(LEGACY_NAME_PREFIX.length) : name;
}

/** What `migrateLegacyLedgerRecords` did. */
export interface LegacyLedgerMigration {
  /** Records copied to their new key. */
  readonly copied: number;
  /** Records whose new key already held a record (left as it is). */
  readonly alreadyThere: number;
}

/**
 * Copy every record under `namespace`'s legacy name (`phalanx/pq/...`) to its
 * new key with `add`: never overwrites, never deletes, idempotent. The ledgers
 * run it themselves before their first operation; call it to report the
 * migration (or to migrate a store no ledger has opened yet).
 */
export async function migrateLegacyLedgerRecords(store: LeafLedgerStore, namespace: string): Promise<LegacyLedgerMigration> {
  if (!namespace.startsWith(NAME_PREFIX)) throw new RangeError(`namespace must start with ${NAME_PREFIX}`);
  let copied = 0;
  let alreadyThere = 0;
  for (const k of await store.keys(legacyName(namespace))) {
    const v = await store.get(k);
    if (v === null || v === undefined) continue;
    if (await store.add(currentName(k), v)) copied++;
    else alreadyThere++;
  }
  return { copied, alreadyThere };
}

/**
 * `store` as seen by a ledger whose keys start with `namespace`
 * (`noised/pq/...`): the legacy records of that namespace are migrated first
 * and honoured on every read and reservation (see the module docs). Keys
 * outside `namespace` pass through.
 */
export function withLegacyNamespace(store: LeafLedgerStore, namespace: string): LeafLedgerStore {
  if (!namespace.startsWith(NAME_PREFIX)) throw new RangeError(`namespace must start with ${NAME_PREFIX}`);
  const mine = (key: string): boolean => key.startsWith(namespace);
  let migrated: Promise<unknown> | null = null;
  const ready = (): Promise<unknown> => {
    migrated ??= migrateLegacyLedgerRecords(store, namespace).catch((e: unknown) => {
      migrated = null; // retried by the next operation; this one fails closed
      throw e;
    });
    return migrated;
  };
  const get = async (key: string): Promise<string | null | undefined> => {
    await ready();
    const v = await store.get(key);
    if ((v !== null && v !== undefined) || !mine(key)) return v;
    const old = await store.get(legacyName(key));
    if (old === null || old === undefined) return v;
    await store.add(key, old); // copy forward (no-op if a record appeared meanwhile)
    return store.get(key);
  };
  return {
    get,
    async add(key, value) {
      await ready();
      if (!mine(key)) return store.add(key, value);
      const legacy = legacyName(key);
      if (!(await store.add(legacy, value))) {
        // An earlier client (or the migration) holds this key under its legacy name: the reservation is refused.
        const old = await store.get(legacy);
        if (old !== null && old !== undefined) await store.add(key, old);
        return false;
      }
      return store.add(key, value);
    },
    async put(key, value) {
      await ready();
      return store.put(key, value);
    },
    async keys(prefix) {
      await ready();
      const own = await store.keys(prefix);
      if (!mine(prefix)) return own;
      const legacy = (await store.keys(legacyName(prefix))).map(currentName);
      return [...new Set([...own, ...legacy])].sort();
    },
    singleRealmOnly: store.singleRealmOnly,
  };
}

/** `lock` taken under the legacy name of `name`, then under `name` (earlier clients take the legacy name only). */
export function withLegacyLock(lock: LedgerLock): LedgerLock {
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const legacy = legacyName(name);
    return legacy === name ? lock(name, fn) : lock(legacy, () => lock(name, fn));
  };
}

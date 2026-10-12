/**
 * IndexedDB databases kept under the project's earlier name (the rename to Noised): `phalanx-ledgers` (the key
 * ledgers, lib/ledger.ts) and `phalanx-launches` (launches in progress, lib/launchFlow.ts). They are opened only to
 * copy their entries into the renamed databases (and, for the key records, to keep honouring them): never created,
 * never written to except to claim a key record (lib/ledger.ts), never deleted.
 */

/**
 * Open the database `name` only if this browser has it (null otherwise: nothing is created), without a version, so a
 * tab of the earlier release that holds it open is never blocked. `stores`: the object stores it must have.
 */
export function openExistingDb(factory: IDBFactory, name: string, stores: readonly string[]): Promise<IDBDatabase | null> {
  return new Promise<IDBDatabase | null>((resolve) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(name);
    } catch {
      resolve(null);
      return;
    }
    let absent = false;
    r.onupgradeneeded = (ev) => {
      // No such database: opening it would create it. Abort, so nothing is created.
      if ((ev as IDBVersionChangeEvent).oldVersion === 0) {
        absent = true;
        r.transaction?.abort();
      }
    };
    r.onsuccess = () => {
      const found = r.result;
      if (absent || !stores.every((s) => found.objectStoreNames.contains(s))) {
        found.close();
        resolve(null);
      } else resolve(found);
    };
    r.onerror = (ev) => {
      ev.preventDefault?.();
      resolve(null);
    };
    r.onblocked = () => resolve(null);
  });
}

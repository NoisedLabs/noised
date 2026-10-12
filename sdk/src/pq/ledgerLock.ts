/**
 * Locks shared by the durable signing ledgers (`./leafLedger.ts` for LMS
 * leaves, `./vaultLedger.ts` for vault keys). Internal: not exported from the
 * package root.
 *
 * A ledger serializes the operations on one record behind a named lock. The
 * default is an in-process mutex, which serializes one JavaScript realm (one
 * tab, one worker, one Node process). A store whose atomic `add` only holds
 * within one realm (Web Storage: check-then-set is atomic inside a tab, not
 * across tabs) must be given a lock that spans realms
 * (`(name, fn) => navigator.locks.request(name, fn)` in a browser), or two
 * tabs could both "add" one key and sign two messages with one one-time key.
 * `ledgerLock` refuses such a store without one.
 */

/** Runs `fn` while holding the lock `name` (e.g. `(name, fn) => navigator.locks.request(name, fn)`). */
export type LedgerLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** An in-process mutex per name (serializes one realm; pass a cross-tab lock for browsers). */
export function processLock(): LedgerLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(name, tail);
    void tail.then(() => {
      if (tails.get(name) === tail) tails.delete(name);
    });
    return run;
  };
}

/**
 * The lock a ledger on `store` uses: `lock` when given; otherwise an
 * in-process mutex, which is refused (thrown) when the store says its `add`
 * is atomic within one realm only (`store.singleRealmOnly`).
 */
export function ledgerLock(store: { readonly singleRealmOnly?: boolean | undefined }, lock: LedgerLock | undefined, what: string): LedgerLock {
  if (lock !== undefined) {
    if (typeof lock !== "function") throw new TypeError(`${what}: opts.lock must be a function (name, fn) => Promise`);
    return lock;
  }
  if (store.singleRealmOnly === true) {
    throw new Error(
      `${what}: this store's add is atomic within one tab only (Web Storage), so it needs a lock shared by every tab: pass opts.lock = (name, fn) => navigator.locks.request(name, fn). Without it two tabs could sign two messages with one one-time key.`,
    );
  }
  return processLock();
}

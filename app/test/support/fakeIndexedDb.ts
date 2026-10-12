/**
 * TEST ONLY: the part of IndexedDB lib/ledger.ts uses, in memory, with the
 * semantics it relies on: `open` runs `onupgradeneeded` for a new database;
 * every connection to one name shares the same data; a transaction runs its
 * requests in order and commits as a whole (`oncomplete`), or aborts
 * (`onabort`) when a failed request's error event is not prevented; `add`
 * fails with a ConstraintError when the key exists. Transactions run one at
 * a time (a macrotask each), which is what IndexedDB guarantees for
 * readwrite transactions on one object store across connections.
 */

type Value = unknown;

interface FakeRequest {
  result: unknown;
  error: { name: string; message: string } | null;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: { preventDefault(): void; stopPropagation(): void }) => void) | null;
}

class FakeObjectStore {
  private readonly tx: FakeTransaction;
  private readonly data: Map<string, Value>;

  constructor(tx: FakeTransaction, data: Map<string, Value>) {
    this.tx = tx;
    this.data = data;
  }

  private request(op: () => { result?: unknown; error?: string }): FakeRequest {
    const r: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.tx.queue.push(() => {
      const out = op();
      if (out.error !== undefined) {
        r.error = { name: out.error, message: out.error };
        let prevented = false;
        r.onerror?.({ preventDefault: () => (prevented = true), stopPropagation: () => undefined });
        if (!prevented) this.tx.fail(r.error);
        return;
      }
      r.result = out.result;
      r.onsuccess?.({});
    });
    return r;
  }

  get(key: string): FakeRequest {
    return this.request(() => ({ result: this.data.get(key) }));
  }

  add(value: Value, key: string): FakeRequest {
    return this.request(() => {
      if (this.tx.mode !== "readwrite") return { error: "ReadOnlyError" };
      if (this.data.has(key)) return { error: "ConstraintError" };
      this.tx.writes.push(() => this.data.set(key, structuredClone(value)));
      return { result: key };
    });
  }

  put(value: Value, key: string): FakeRequest {
    return this.request(() => {
      if (this.tx.mode !== "readwrite") return { error: "ReadOnlyError" };
      this.tx.writes.push(() => this.data.set(key, structuredClone(value)));
      return { result: key };
    });
  }

  getAllKeys(): FakeRequest {
    return this.request(() => ({ result: [...this.data.keys()].sort() }));
  }

  getAll(): FakeRequest {
    return this.request(() => ({ result: [...this.data.keys()].sort().map((k) => structuredClone(this.data.get(k))) }));
  }
}

class FakeTransaction {
  readonly queue: (() => void)[] = [];
  readonly writes: (() => void)[] = [];
  error: { name: string; message: string } | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private failed = false;
  private readonly db: FakeDatabase;
  readonly storeName: string;
  readonly mode: "readonly" | "readwrite";

  constructor(db: FakeDatabase, storeName: string, mode: "readonly" | "readwrite") {
    this.db = db;
    this.storeName = storeName;
    this.mode = mode;
  }

  objectStore(name: string): FakeObjectStore {
    if (name !== this.storeName) throw new Error(`NotFoundError: ${name} is not in this transaction's scope`);
    return new FakeObjectStore(this, this.db.backing.stores.get(name) ?? new Map());
  }

  fail(error: { name: string; message: string }): void {
    this.failed = true;
    this.error = error;
  }

  /** Run every request, then commit the writes at once (or none of them). */
  run(): void {
    for (const step of this.queue) {
      if (this.failed) break;
      step();
    }
    if (this.failed) {
      this.onerror?.();
      this.onabort?.();
      return;
    }
    for (const w of this.writes) w();
    this.db.backing.commits++;
    this.oncomplete?.();
  }
}

interface Backing {
  stores: Map<string, Map<string, Value>>;
  version: number;
  commits: number;
  closes?: number;
}

class FakeDatabase {
  readonly backing: Backing;

  constructor(backing: Backing) {
    this.backing = backing;
  }

  get objectStoreNames(): { contains(name: string): boolean } {
    return { contains: (name: string) => this.backing.stores.has(name) };
  }

  close(): void {
    this.backing.closes = (this.backing.closes ?? 0) + 1;
  }

  createObjectStore(name: string): void {
    if (!this.backing.stores.has(name)) this.backing.stores.set(name, new Map());
  }

  transaction(storeName: string, mode: "readonly" | "readwrite" = "readonly"): FakeTransaction {
    if (!this.backing.stores.has(storeName)) throw new Error(`NotFoundError: no object store ${storeName}`);
    const tx = new FakeTransaction(this, storeName, mode);
    // Requests are queued synchronously by the caller; the transaction runs on its own turn, one at a time.
    serial = serial.then(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            tx.run();
            resolve();
          }, 0),
        ),
    );
    return tx;
  }
}

let serial: Promise<void> = Promise.resolve();

/** An in-memory `IDBFactory` stand-in. `databases` exposes the stored data for assertions. */
export class FakeIndexedDb {
  readonly databases = new Map<string, Backing>();
  opens = 0;

  /**
   * `version` omitted: the database's current version (1 for a new one), like IndexedDB. `onupgradeneeded` gets the
   * old version (0 for a new database); `transaction.abort()` there fails the open (AbortError) and creates nothing.
   */
  open(
    name: string,
    version?: number,
  ): {
    result: FakeDatabase;
    error: unknown;
    transaction: { abort(): void } | null;
    onupgradeneeded: ((ev: { oldVersion: number }) => void) | null;
    onsuccess: (() => void) | null;
    onerror: ((ev: { preventDefault(): void }) => void) | null;
    onblocked: (() => void) | null;
  } {
    this.opens++;
    let aborted = false;
    const r = {
      result: undefined as unknown as FakeDatabase,
      error: null as unknown,
      transaction: null as { abort(): void } | null,
      onupgradeneeded: null as ((ev: { oldVersion: number }) => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as ((ev: { preventDefault(): void }) => void) | null,
      onblocked: null as (() => void) | null,
    };
    setTimeout(() => {
      const existing = this.databases.get(name);
      const target = version ?? existing?.version ?? 1;
      const fresh = existing === undefined || existing.version < target;
      const backing = existing ?? { stores: new Map(), version: target, commits: 0 };
      const oldVersion = existing?.version ?? 0;
      if (existing === undefined) this.databases.set(name, backing);
      backing.version = target;
      r.result = new FakeDatabase(backing);
      if (fresh) {
        r.transaction = {
          abort: () => {
            aborted = true;
          },
        };
        r.onupgradeneeded?.({ oldVersion });
        r.transaction = null;
        if (aborted) {
          if (existing === undefined) this.databases.delete(name);
          else backing.version = oldVersion;
          r.error = { name: "AbortError", message: "AbortError" };
          r.onerror?.({ preventDefault: () => undefined });
          return;
        }
      }
      r.onsuccess?.();
    }, 0);
    return r;
  }

  /** What is stored in `store` of database `name` (committed writes only). */
  dump(name: string, store: string): Map<string, Value> {
    return this.databases.get(name)?.stores.get(store) ?? new Map();
  }
}

/** A `navigator.locks` stand-in: one exclusive lock per name, granted in request order, shared by every "tab" holding it. */
export class FakeLocks {
  private readonly tails = new Map<string, Promise<void>>();
  readonly requested: string[] = [];

  request<T>(name: string, _options: { mode: "exclusive" }, callback: (lock: unknown) => Promise<T>): Promise<T> {
    this.requested.push(name);
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = prev.then(() => callback({ name }));
    this.tails.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

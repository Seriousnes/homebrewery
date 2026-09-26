// A small key-value store over IndexedDB (idb-keyval), with an in-memory twin for tests and for
// browsers without IndexedDB. Port of legacy/client/homebrew/utils/customIDBStore.js.
//
// Drafts and snapshots each get their own database, because idb-keyval opens a database with a
// single object store: two createStore calls with one database name and different store names
// would fight over the schema version. fallbackStore puts a memory store behind IndexedDB for
// browsers where it fails (site data blocked, a broken profile, quota).
import { createStore, del, delMany, entries, get, getMany, set, setMany, type UseStore } from 'idb-keyval';

export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<(T | undefined)[]>;
  set(key: string, value: T): Promise<void>;
  setMany(items: [string, T][]): Promise<void>;
  del(key: string): Promise<void>;
  delMany(keys: string[]): Promise<void>;
  entries(): Promise<[string, T][]>;
}

/** True when this browser exposes IndexedDB (false in jsdom and some private modes). */
export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** A store in its own IndexedDB database (created on first use). */
export function idbStore<T>(dbName: string, storeName: string): KeyValueStore<T> {
  let store: UseStore | undefined;
  const idb = (): UseStore => (store ??= createStore(dbName, storeName));
  return {
    get: (key) => get<T>(key, idb()),
    getMany: (keys) => getMany<T>(keys, idb()),
    set: (key, value) => set(key, value, idb()),
    setMany: (items) => setMany(items, idb()),
    del: (key) => del(key, idb()),
    delMany: (keys) => delMany(keys, idb()),
    entries: () => entries<string, T>(idb()),
  };
}

/** A store that can tell whether what it holds outlives the page. */
export interface FallbackStore<T> extends KeyValueStore<T> {
  /** false once the fallback is in use: values then last only as long as the page. */
  persistent(): boolean;
}

const PROBE_KEY = '__hb_probe__';

/**
 * `primary` (IndexedDB) while it works, else `fallback` (memory) for the rest of the page's life.
 * The first operation probes the primary with a read, which opens the database and runs a
 * transaction: when site data is blocked (Firefox throws SecurityError from indexedDB.open, Chrome
 * fails the open) or the profile is broken, every operation uses the fallback. A write that fails
 * later (quota) switches too, and keeps its value in the fallback; reads then look in the
 * fallback first and in the primary for what it stored before. Keep one per page (a module-level
 * store) so the fallback survives client-side navigation.
 */
export function fallbackStore<T>(primary: KeyValueStore<T>, fallback: KeyValueStore<T> = memoryStore<T>()): FallbackStore<T> {
  let failed = false;
  let probe: Promise<void> | undefined;
  const ready = (): Promise<void> =>
    (probe ??= (async () => {
      try {
        await primary.get(PROBE_KEY);
      } catch {
        failed = true;
      }
    })());
  /** The primary's answer, or `otherwise` when it throws (it may throw synchronously). */
  const fromPrimary = async <R>(op: (store: KeyValueStore<T>) => Promise<R>, otherwise: R): Promise<R> => {
    try {
      return await op(primary);
    } catch {
      return otherwise;
    }
  };
  async function write(op: (store: KeyValueStore<T>) => Promise<void>): Promise<void> {
    await ready();
    if (!failed) {
      try {
        await op(primary);
        return;
      } catch {
        failed = true;
      }
    }
    await op(fallback);
  }
  async function get(key: string): Promise<T | undefined> {
    await ready();
    if (!failed) return primary.get(key);
    return (await fallback.get(key)) ?? fromPrimary((store) => store.get(key), undefined);
  }
  return {
    persistent: () => !failed,
    get,
    getMany: async (keys) => Promise.all(keys.map(get)),
    set: (key, value) => write((store) => store.set(key, value)),
    setMany: (items) => write((store) => store.setMany(items)),
    async del(key) {
      await ready();
      if (!failed) return primary.del(key);
      await fromPrimary((store) => store.del(key), undefined);
      await fallback.del(key);
    },
    async delMany(keys) {
      await ready();
      if (!failed) return primary.delMany(keys);
      await fromPrimary((store) => store.delMany(keys), undefined);
      await fallback.delMany(keys);
    },
    async entries() {
      await ready();
      if (!failed) return primary.entries();
      const own = await fallback.entries();
      const seen = new Set(own.map(([key]) => key));
      const older = await fromPrimary((store) => store.entries(), [] as [string, T][]);
      return [...own, ...older.filter(([key]) => !seen.has(key))];
    },
  };
}

/**
 * An in-memory store. Values are structured-cloned on the way in and out, as IndexedDB does, so
 * tests can't pass by sharing objects with the code under test.
 */
export function memoryStore<T>(initial: Iterable<[string, T]> = []): KeyValueStore<T> & { map: Map<string, T> } {
  const map = new Map<string, T>();
  for (const [key, value] of initial) map.set(key, structuredClone(value));
  const out = (value: T | undefined) => (value === undefined ? undefined : structuredClone(value));
  return {
    map,
    get: (key) => Promise.resolve(out(map.get(key))),
    getMany: (keys) => Promise.resolve(keys.map((key) => out(map.get(key)))),
    set: (key, value) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setMany: (items) => {
      for (const [key, value] of items) map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    del: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
    delMany: (keys) => {
      for (const key of keys) map.delete(key);
      return Promise.resolve();
    },
    entries: () => Promise.resolve([...map.entries()].map(([key, value]) => [key, structuredClone(value)] as [string, T])),
  };
}

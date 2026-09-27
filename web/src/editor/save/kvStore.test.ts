// kvStore.ts: the memory store and the IndexedDB fallback (SAVE-11). idbStore itself runs in real
// browsers only (jsdom has no IndexedDB): web/e2e/save/stores.spec.ts.
import { describe, expect, it } from 'vitest';
import { fallbackStore, memoryStore, type KeyValueStore } from './kvStore';

/** A store whose every call fails, synchronously like indexedDB.open in Firefox with site data blocked. */
function brokenStore<T>(): KeyValueStore<T> {
  const fail = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { get: fail, getMany: fail, set: fail, setMany: fail, del: fail, delMany: fail, entries: fail, keys: fail };
}

/** A store that works until `full` is set, then refuses writes (quota). */
function fillingStore<T>() {
  const inner = memoryStore<T>();
  const state = { full: false };
  const store: KeyValueStore<T> = {
    ...inner,
    set: (key, value) => (state.full ? Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError')) : inner.set(key, value)),
    setMany: (items) => (state.full ? Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError')) : inner.setMany(items)),
  };
  return { store, inner, state };
}

describe('memoryStore', () => {
  it('clones values on the way in and out', async () => {
    const store = memoryStore<{ n: number }>();
    const value = { n: 1 };
    await store.set('a', value);
    value.n = 2;
    const read = await store.get('a');
    expect(read).toEqual({ n: 1 });
    read!.n = 3;
    expect(await store.get('a')).toEqual({ n: 1 });
    await store.setMany([['b', { n: 2 }]]);
    expect(await store.getMany(['a', 'b', 'c'])).toEqual([{ n: 1 }, { n: 2 }, undefined]);
    await store.delMany(['a']);
    expect(await store.entries()).toEqual([['b', { n: 2 }]]);
  });
});

describe('fallbackStore', () => {
  it('uses the primary while it works', async () => {
    const primary = memoryStore<number>();
    const store = fallbackStore(primary);
    await store.set('a', 1);
    expect(primary.map.get('a')).toBe(1);
    expect(await store.get('a')).toBe(1);
    expect(store.persistent()).toBe(true);
  });

  it('a primary that fails at once (site data blocked): memory for the page, not persistent', async () => {
    const fallback = memoryStore<number>();
    const store = fallbackStore(brokenStore<number>(), fallback);
    await store.set('a', 1);
    await store.setMany([['b', 2]]);
    expect(await store.get('a')).toBe(1);
    expect(await store.getMany(['a', 'b'])).toEqual([1, 2]);
    expect(await store.entries()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    await store.del('a');
    await store.delMany(['b']);
    expect(await store.entries()).toEqual([]);
    expect(fallback.map.size).toBe(0);
    expect(store.persistent()).toBe(false);
  });

  it('a write that fails later (quota) switches, keeps the value and still reads what the primary had', async () => {
    const { store: primary, inner, state } = fillingStore<number>();
    const store = fallbackStore(primary);
    await store.set('old', 1);
    state.full = true;
    await store.set('new', 2);
    expect(store.persistent()).toBe(false);
    expect(inner.map.has('new')).toBe(false);
    expect(await store.get('new')).toBe(2);
    expect(await store.get('old')).toBe(1);
    expect((await store.entries()).sort()).toEqual([
      ['new', 2],
      ['old', 1],
    ]);
    await store.del('old');
    expect(await store.get('old')).toBeUndefined();
  });
});

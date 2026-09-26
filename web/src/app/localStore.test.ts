import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalStore, useLocalStore } from './localStore';

const parseList = (raw: unknown): readonly string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('createLocalStore', () => {
  it('reads the fallback when nothing is stored and persists writes as JSON', () => {
    const store = createLocalStore({ key: 'test-list', parse: parseList, fallback: [] });
    expect(store.get()).toEqual([]);
    store.set(['a']);
    expect(window.localStorage.getItem('test-list')).toBe('["a"]');
    store.set((list) => [...list, 'b']);
    expect(store.get()).toEqual(['a', 'b']);
  });

  it('returns the same reference until the stored value changes', () => {
    window.localStorage.setItem('test-list', '["x"]');
    const store = createLocalStore({ key: 'test-list', parse: parseList, fallback: [] });
    const first = store.get();
    expect(store.get()).toBe(first);
    window.localStorage.setItem('test-list', '["y"]');
    expect(store.get()).not.toBe(first);
    expect(store.get()).toEqual(['y']);
  });

  it('falls back on corrupt JSON and validates stored values', () => {
    window.localStorage.setItem('test-list', '{not json');
    const store = createLocalStore({ key: 'test-list', parse: parseList, fallback: [] });
    expect(store.get()).toEqual([]);
    window.localStorage.setItem('test-list', '["ok", 3, null]');
    expect(store.get()).toEqual(['ok']);
  });

  it('keeps working in memory when storage is unavailable or full', () => {
    const blocked = createLocalStore({
      key: 'k',
      parse: parseList,
      fallback: [],
      storage: () => {
        throw new Error('SecurityError');
      },
    });
    blocked.set(['kept']);
    expect(blocked.get()).toEqual(['kept']);

    const full = memoryStorage();
    full.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const store = createLocalStore({ key: 'k', parse: parseList, fallback: [], storage: () => full });
    store.set(['in memory']);
    expect(store.get()).toEqual(['in memory']);
  });

  it('reset removes the key and notifies', () => {
    const store = createLocalStore({ key: 'test-list', parse: parseList, fallback: [] });
    store.set(['a']);
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(window.localStorage.getItem('test-list')).toBeNull();
    expect(store.get()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on other tabs' changes (storage events) and on writes", () => {
    const store = createLocalStore({ key: 'test-list', parse: parseList, fallback: [] });
    const { result } = renderHook(() => useLocalStore(store));
    expect(result.current).toEqual([]);
    act(() => store.set(['mine']));
    expect(result.current).toEqual(['mine']);
    act(() => {
      window.localStorage.setItem('test-list', '["theirs"]');
      window.dispatchEvent(new StorageEvent('storage', { key: 'test-list' }));
    });
    expect(result.current).toEqual(['theirs']);
    // Other keys are ignored.
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    window.dispatchEvent(new StorageEvent('storage', { key: 'other' }));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not notify when a write leaves the value unchanged', () => {
    const store = createLocalStore({ key: 'test-list', parse: parseList, fallback: [] });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((list) => list);
    expect(listener).not.toHaveBeenCalled();
  });
});

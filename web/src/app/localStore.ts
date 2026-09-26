// A tiny persisted store for per-browser lists (recent brews, dismissed notices). The value lives
// in localStorage as JSON, is validated on every read (storage is user-editable and shared with
// other tabs and older app versions), and stays usable in memory when storage is blocked, full or
// corrupt. Other tabs' changes arrive through the `storage` event.
import { useSyncExternalStore } from 'react';

export interface LocalStore<T> {
  /** The current value (a stable reference until it changes). */
  get: () => T;
  /** Replace the value, or derive it from the current one. Persists and notifies. */
  set: (next: T | ((current: T) => T)) => void;
  /** Back to the fallback; removes the stored key. */
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
  readonly key: string;
  readonly fallback: T;
}

export interface LocalStoreOptions<T> {
  key: string;
  /** Turn the parsed JSON (anything) into a valid value; return the fallback when unusable. */
  parse: (raw: unknown) => T;
  fallback: T;
  /** Default: window.localStorage (null when unavailable). */
  storage?: () => Storage | null;
}

/** window.localStorage, or null when it is missing or access throws (blocked cookies, sandboxes). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function createLocalStore<T>({ key, parse, fallback, storage = browserStorage }: LocalStoreOptions<T>): LocalStore<T> {
  const listeners = new Set<() => void>();
  // The last raw string read and its parsed value: get() must return the same reference while
  // nothing changed (useSyncExternalStore compares snapshots with Object.is).
  let cachedRaw: string | null | undefined;
  let cachedValue: T = fallback;
  // Used instead of storage when writing failed, so the session still sees its own changes.
  let memory: { value: T } | null = null;

  const read = (): string | null => {
    try {
      return storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };

  const get = (): T => {
    if (memory) return memory.value;
    const raw = read();
    if (raw === cachedRaw) return cachedValue;
    cachedRaw = raw;
    if (raw == null) {
      cachedValue = fallback;
    } else {
      try {
        cachedValue = parse(JSON.parse(raw));
      } catch {
        cachedValue = fallback;
      }
    }
    return cachedValue;
  };

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const write = (value: T) => {
    try {
      const target = storage();
      if (!target) throw new Error('no storage');
      const raw = JSON.stringify(value);
      target.setItem(key, raw);
      cachedRaw = raw;
      cachedValue = value;
      memory = null;
    } catch {
      memory = { value };
    }
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    memory = null;
    notify();
  };

  return {
    key,
    fallback,
    get,
    set: (next) => {
      const value = typeof next === 'function' ? (next as (current: T) => T)(get()) : next;
      if (Object.is(value, get())) return;
      write(value);
      notify();
    },
    reset: () => {
      try {
        storage()?.removeItem(key);
      } catch {
        // Nothing stored that we can reach.
      }
      cachedRaw = null;
      cachedValue = fallback;
      memory = null;
      notify();
    },
    subscribe: (listener) => {
      if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      };
    },
  };
}

/** Subscribe a component to a LocalStore. */
export function useLocalStore<T>(store: LocalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, () => store.fallback);
}

import { describe, expect, it } from 'vitest';
import {
  createListPrefsStore,
  DEFAULT_LIST_PREFS,
  LEGACY_GROUP_PREFIX,
  LEGACY_SORT_DIR_KEY,
  LEGACY_SORT_TYPE_KEY,
  LIST_PREFS_KEY,
  parseListPrefs,
  readLegacyListPrefs,
} from './listPrefs';

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
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

describe('list preferences', () => {
  it('validates stored JSON field by field', () => {
    expect(parseListPrefs({ sort: 'views', dir: 'desc', collapsed: ['invited', 'nope', 'invited', 3] })).toEqual({ sort: 'views', dir: 'desc', collapsed: ['invited'] });
    expect(parseListPrefs({ sort: 'bogus', dir: 1 })).toEqual({ ...DEFAULT_LIST_PREFS, collapsed: [] });
    expect(parseListPrefs('garbage')).toBe(DEFAULT_LIST_PREFS);
  });

  it("imports upstream's keys when the new key is absent", () => {
    const storage = memoryStorage({
      [LEGACY_SORT_TYPE_KEY]: 'alpha',
      [LEGACY_SORT_DIR_KEY]: 'desc',
      [`${LEGACY_GROUP_PREFIX}unpublished`]: 'false',
      [`${LEGACY_GROUP_PREFIX}published`]: 'true',
    });
    expect(readLegacyListPrefs(storage)).toEqual({ sort: 'title', dir: 'desc', collapsed: ['unpublished'] });
    const store = createListPrefsStore(() => storage);
    expect(store.get()).toEqual({ sort: 'title', dir: 'desc', collapsed: ['unpublished'] });
    // The new key wins once written.
    store.set({ sort: 'views', dir: 'asc', collapsed: [] });
    expect(JSON.parse(storage.getItem(LIST_PREFS_KEY)!)).toEqual({ sort: 'views', dir: 'asc', collapsed: [] });
    expect(createListPrefsStore(() => storage).get()).toEqual({ sort: 'views', dir: 'asc', collapsed: [] });
  });

  it('works without storage', () => {
    expect(readLegacyListPrefs(null)).toBeNull();
    const store = createListPrefsStore(() => null);
    store.set({ sort: 'pages', dir: 'desc', collapsed: ['published'] });
    expect(store.get()).toEqual({ sort: 'pages', dir: 'desc', collapsed: ['published'] });
  });
});

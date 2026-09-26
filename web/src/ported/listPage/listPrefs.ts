// Per-browser preferences of the user page (upstream kept them in localStorage too: the last sort,
// its direction and which groups are collapsed). Stored as 'hb-list-page'; when that key is
// absent, upstream's HB_listPage_* keys are read once, so returning users keep their choice.
import { browserStorage, createLocalStore, useLocalStore } from '@/app/localStore';
import { DEFAULT_LIST_SORT, DEFAULT_SORT_DIR, GROUP_IDS, type GroupId, parseListSort, parseSortDir, type SortPrefs } from './listModel';

export interface ListPrefs extends SortPrefs {
  /** Groups the reader closed (upstream: HB_listPage_visibility_group_<class> = 'false'). */
  collapsed: GroupId[];
}

export const LIST_PREFS_KEY = 'hb-list-page';
export const LEGACY_SORT_TYPE_KEY = 'HB_listPage_sortType';
export const LEGACY_SORT_DIR_KEY = 'HB_listPage_sortDir';
export const LEGACY_GROUP_PREFIX = 'HB_listPage_visibility_group_';

export const DEFAULT_LIST_PREFS: ListPrefs = Object.freeze({ sort: DEFAULT_LIST_SORT, dir: DEFAULT_SORT_DIR, collapsed: [] as GroupId[] });

const isGroupId = (v: unknown): v is GroupId => typeof v === 'string' && (GROUP_IDS as readonly string[]).includes(v);

/** Validated preferences from stored JSON (anything unusable falls back to the default). */
export function parseListPrefs(raw: unknown, fallback: ListPrefs = DEFAULT_LIST_PREFS): ListPrefs {
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Record<string, unknown>;
  const collapsed = Array.isArray(r.collapsed) ? [...new Set(r.collapsed.filter(isGroupId))] : [];
  return {
    sort: parseListSort(typeof r.sort === 'string' ? r.sort : null) ?? fallback.sort,
    dir: parseSortDir(typeof r.dir === 'string' ? r.dir : null) ?? fallback.dir,
    collapsed,
  };
}

/** Upstream's keys, when a browser has them (null otherwise). */
export function readLegacyListPrefs(storage: Storage | null = browserStorage()): ListPrefs | null {
  if (!storage) return null;
  try {
    const sort = parseListSort(storage.getItem(LEGACY_SORT_TYPE_KEY));
    const dir = parseSortDir(storage.getItem(LEGACY_SORT_DIR_KEY));
    const collapsed = GROUP_IDS.filter((id) => storage.getItem(`${LEGACY_GROUP_PREFIX}${id}`) === 'false');
    if (!sort && !dir && collapsed.length === 0) return null;
    return { sort: sort ?? DEFAULT_LIST_SORT, dir: dir ?? DEFAULT_SORT_DIR, collapsed };
  } catch {
    return null;
  }
}

export function createListPrefsStore(storage: () => Storage | null = browserStorage) {
  const fallback = readLegacyListPrefs(storage()) ?? DEFAULT_LIST_PREFS;
  return createLocalStore<ListPrefs>({ key: LIST_PREFS_KEY, parse: (raw) => parseListPrefs(raw, fallback), fallback, storage });
}

let store: ReturnType<typeof createListPrefsStore> | undefined;

/** The app's store (created on first use, so upstream's keys are read only when a list page opens). */
export function listPrefsStore() {
  return (store ??= createListPrefsStore());
}

export function useListPrefs(): ListPrefs {
  return useLocalStore(listPrefsStore());
}

export function setSortPrefs(prefs: SortPrefs): void {
  listPrefsStore().set((current) => (current.sort === prefs.sort && current.dir === prefs.dir ? current : { ...current, ...prefs }));
}

export function setGroupCollapsed(id: GroupId, collapsed: boolean): void {
  listPrefsStore().set((current) => {
    const has = current.collapsed.includes(id);
    if (has === collapsed) return current;
    return { ...current, collapsed: collapsed ? [...current.collapsed, id] : current.collapsed.filter((g) => g !== id) };
  });
}

/** Tests: forget the app's store (the next use reads storage again). */
export function resetListPrefsStoreForTests(): void {
  store = undefined;
}

// Recently edited and viewed brews for the navbar's "Recent" list (port of legacy
// client/homebrew/navbar/recent.navitem.jsx). Per browser, in localStorage; at most 8 of each,
// newest first. Upstream kept two keys (HB_nav_recentlyEdited/Viewed) whose ids point at
// upstream's brews, so they are not imported. The editor and share pages call
// useRecordRecentBrew(); URLs are always rebuilt from the kind and id, never read from storage.
import { useEffect } from 'react';
import { createLocalStore, useLocalStore } from './localStore';
import { paths } from './paths';

export type RecentKind = 'edit' | 'view';

export interface RecentBrew {
  /** editId for 'edit', shareId for 'view'. */
  id: string;
  title: string;
  /** When it was last opened (ms since the epoch). */
  ts: number;
}

export interface RecentBrews {
  edit: readonly RecentBrew[];
  view: readonly RecentBrew[];
}

export const RECENT_STORAGE_KEY = 'hb-recent-brews';
export const RECENT_LIMIT = 8;
export const RECENT_TITLE_MAX = 200;

const EMPTY: RecentBrews = Object.freeze({ edit: Object.freeze([]), view: Object.freeze([]) });
const ID = /^[\w-]{1,64}$/;

function parseList(value: unknown): RecentBrew[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: RecentBrew[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, ts } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) continue;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    seen.add(id);
    list.push({ id, title: typeof title === 'string' ? title.slice(0, RECENT_TITLE_MAX) : '', ts });
    if (list.length === RECENT_LIMIT) break;
  }
  return list;
}

export function parseRecentBrews(raw: unknown): RecentBrews {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const { edit, view } = raw as Record<string, unknown>;
  return { edit: parseList(edit), view: parseList(view) };
}

export const recentBrewsStore = createLocalStore<RecentBrews>({
  key: RECENT_STORAGE_KEY,
  parse: parseRecentBrews,
  fallback: EMPTY,
});

/** The page a recent entry opens. */
export function recentBrewUrl(kind: RecentKind, id: string): string {
  return kind === 'edit' ? paths.edit(id) : paths.share(id);
}

/** The lists after opening a brew: it moves to the front with its current title and time. */
export function withRecentBrew(state: RecentBrews, kind: RecentKind, brew: { id: string; title?: string | null }, now: number): RecentBrews {
  if (!ID.test(brew.id)) return state;
  const entry: RecentBrew = { id: brew.id, title: (brew.title ?? '').slice(0, RECENT_TITLE_MAX), ts: now };
  const list = [entry, ...state[kind].filter((item) => item.id !== brew.id)].slice(0, RECENT_LIMIT);
  return { ...state, [kind]: list };
}

export function withoutRecentBrew(state: RecentBrews, kind: RecentKind, id: string): RecentBrews {
  if (!state[kind].some((item) => item.id === id)) return state;
  return { ...state, [kind]: state[kind].filter((item) => item.id !== id) };
}

/** Remember that a brew was opened for editing ('edit') or viewing ('view'). */
export function recordRecentBrew(kind: RecentKind, brew: { id: string; title?: string | null }, now = Date.now()): void {
  recentBrewsStore.set((state) => withRecentBrew(state, kind, brew, now));
}

export function removeRecentBrew(kind: RecentKind, id: string): void {
  recentBrewsStore.set((state) => withoutRecentBrew(state, kind, id));
}

export function clearRecentBrews(): void {
  recentBrewsStore.reset();
}

export function useRecentBrews(): RecentBrews {
  return useLocalStore(recentBrewsStore);
}

/**
 * For the editor (kind 'edit', the editId) and share (kind 'view', the shareId) pages: records the
 * brew when it is opened and again when its id or title changes. Pass null while loading.
 */
export function useRecordRecentBrew(kind: RecentKind, brew: { id: string; title?: string | null } | null | undefined): void {
  const id = brew?.id;
  const title = brew?.title ?? '';
  useEffect(() => {
    if (id) recordRecentBrew(kind, { id, title });
  }, [kind, id, title]);
}

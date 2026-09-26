// Dismissed site notifications (port of legacy notificationPopup: the dismissKey is remembered in
// the browser). One localStorage entry holds the keys, newest last, capped so it can't grow
// forever; an admin who wants a notice shown again gives it a new dismissKey.
import { createLocalStore, useLocalStore } from './localStore';

export const NOTICE_DISMISSALS_KEY = 'hb-dismissed-notices';
export const MAX_DISMISSED_NOTICES = 100;
const MAX_KEY_LENGTH = 100; // NotificationInput.dismissKey limit on the server

const EMPTY: readonly string[] = Object.freeze([]);

export function parseDismissedNotices(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return EMPTY;
  const keys = raw.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH);
  return [...new Set(keys)].slice(-MAX_DISMISSED_NOTICES);
}

export const noticeDismissalsStore = createLocalStore<readonly string[]>({
  key: NOTICE_DISMISSALS_KEY,
  parse: parseDismissedNotices,
  fallback: EMPTY,
});

export function withDismissedNotice(keys: readonly string[], dismissKey: string): readonly string[] {
  if (!dismissKey || keys.includes(dismissKey)) return keys;
  return [...keys, dismissKey].slice(-MAX_DISMISSED_NOTICES);
}

export function dismissNotice(dismissKey: string): void {
  noticeDismissalsStore.set((keys) => withDismissedNotice(keys, dismissKey));
}

export function useDismissedNotices(): readonly string[] {
  return useLocalStore(noticeDismissalsStore);
}

/** How often the banner refetches the active notices (the server only returns active ones). */
export const NOTICE_REFETCH_MS = 15 * 60_000;

/** The notices to show: those not dismissed in this browser, in the server's order. */
export function visibleNotices<T extends { dismissKey: string }>(notices: readonly T[], dismissed: readonly string[]): T[] {
  return notices.filter((notice) => !dismissed.includes(notice.dismissKey));
}

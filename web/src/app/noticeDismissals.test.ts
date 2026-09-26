import { afterEach, describe, expect, it } from 'vitest';
import {
  dismissNotice,
  MAX_DISMISSED_NOTICES,
  NOTICE_DISMISSALS_KEY,
  noticeDismissalsStore,
  parseDismissedNotices,
  visibleNotices,
  withDismissedNotice,
} from './noticeDismissals';

afterEach(() => {
  noticeDismissalsStore.reset();
  window.localStorage.clear();
});

describe('notice dismissals', () => {
  it('remembers dismissed keys in localStorage', () => {
    dismissNotice('maintenance-2026-09');
    dismissNotice('maintenance-2026-09');
    dismissNotice('new-themes');
    expect(JSON.parse(window.localStorage.getItem(NOTICE_DISMISSALS_KEY) ?? '[]')).toEqual(['maintenance-2026-09', 'new-themes']);
  });

  it('keeps the newest keys when the list is full', () => {
    let keys: readonly string[] = [];
    for (let i = 0; i < MAX_DISMISSED_NOTICES + 5; i++) keys = withDismissedNotice(keys, `k${i}`);
    expect(keys).toHaveLength(MAX_DISMISSED_NOTICES);
    expect(keys[0]).toBe('k5');
    expect(keys.at(-1)).toBe(`k${MAX_DISMISSED_NOTICES + 4}`);
  });

  it('validates stored data', () => {
    expect(parseDismissedNotices({ a: 1 })).toEqual([]);
    expect(parseDismissedNotices(['a', 'a', '', 7, 'x'.repeat(101), 'b'])).toEqual(['a', 'b']);
  });

  it('shows the notices that were not dismissed, in order', () => {
    const notices = [{ dismissKey: 'a' }, { dismissKey: 'b' }, { dismissKey: 'c' }];
    expect(visibleNotices(notices, ['b'])).toEqual([{ dismissKey: 'a' }, { dismissKey: 'c' }]);
  });
});

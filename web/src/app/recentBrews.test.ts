import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRecentBrews,
  parseRecentBrews,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  recentBrewsStore,
  recentBrewUrl,
  recordRecentBrew,
  removeRecentBrew,
  useRecordRecentBrew,
  withRecentBrew,
} from './recentBrews';

afterEach(() => {
  clearRecentBrews();
  window.localStorage.clear();
});

const empty = { edit: [], view: [] };

describe('recent brews', () => {
  it('puts the latest brew first, without duplicates, and keeps at most 8 per list', () => {
    let state = parseRecentBrews(null);
    for (let i = 0; i < 10; i++) state = withRecentBrew(state, 'edit', { id: `brew${i}`, title: `Brew ${i}` }, 1000 + i);
    expect(state.edit).toHaveLength(RECENT_LIMIT);
    expect(state.edit[0]).toEqual({ id: 'brew9', title: 'Brew 9', ts: 1009 });
    state = withRecentBrew(state, 'edit', { id: 'brew5', title: 'Renamed' }, 2000);
    expect(state.edit.map((b) => b.id)).toEqual(['brew5', 'brew9', 'brew8', 'brew7', 'brew6', 'brew4', 'brew3', 'brew2']);
    expect(state.edit[0]?.title).toBe('Renamed');
    expect(state.view).toEqual([]);
  });

  it('ignores ids that are not brew ids and caps titles', () => {
    expect(withRecentBrew(empty, 'view', { id: '../x' }, 1)).toBe(empty);
    const state = withRecentBrew(empty, 'view', { id: 'ok', title: 'x'.repeat(500) }, 1);
    expect(state.view[0]?.title).toHaveLength(200);
  });

  it('validates what it reads from storage', () => {
    const parsed = parseRecentBrews({
      edit: [
        { id: 'good', title: 'Good', ts: 5 },
        { id: 'good', title: 'Duplicate', ts: 6 },
        { id: 'javascript:alert(1)', title: 'Bad id', ts: 1 },
        { id: 'nots', title: 'No time' },
        { id: 'notitle', ts: 2, url: 'https://evil.example' },
        'junk',
      ],
      view: 'nope',
    });
    expect(parsed).toEqual({ edit: [{ id: 'good', title: 'Good', ts: 5 }, { id: 'notitle', title: '', ts: 2 }], view: [] });
    expect(parseRecentBrews('garbage')).toEqual(empty);
  });

  it('persists, removes and clears', () => {
    recordRecentBrew('edit', { id: 'e1', title: 'One' }, 10);
    recordRecentBrew('view', { id: 's1', title: 'Shared' }, 11);
    expect(JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? 'null')).toEqual({
      edit: [{ id: 'e1', title: 'One', ts: 10 }],
      view: [{ id: 's1', title: 'Shared', ts: 11 }],
    });
    removeRecentBrew('edit', 'e1');
    expect(recentBrewsStore.get().edit).toEqual([]);
    expect(recentBrewsStore.get().view).toHaveLength(1);
    clearRecentBrews();
    expect(window.localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull();
  });

  it('builds URLs from the kind and id', () => {
    expect(recentBrewUrl('edit', 'abc')).toBe('/edit/abc');
    expect(recentBrewUrl('view', 'abc')).toBe('/share/abc');
  });

  it('useRecordRecentBrew records when the id or title changes, not while loading', () => {
    const { rerender } = renderHook(({ brew }) => useRecordRecentBrew('edit', brew), {
      initialProps: { brew: null as { id: string; title: string } | null },
    });
    expect(recentBrewsStore.get().edit).toEqual([]);
    rerender({ brew: { id: 'e1', title: 'Draft' } });
    expect(recentBrewsStore.get().edit.map((b) => [b.id, b.title])).toEqual([['e1', 'Draft']]);
    rerender({ brew: { id: 'e1', title: 'Final' } });
    expect(recentBrewsStore.get().edit.map((b) => [b.id, b.title])).toEqual([['e1', 'Final']]);
    rerender({ brew: { id: 'e2', title: 'Other' } });
    expect(recentBrewsStore.get().edit.map((b) => b.id)).toEqual(['e2', 'e1']);
  });
});

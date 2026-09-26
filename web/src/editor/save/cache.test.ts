// cache.ts: what autosave's saves and creates do to the TanStack Query cache (APP-13: user themes
// are brews tagged meta:theme, so the theme list goes stale when such a brew is saved).
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys, type SaveBrewRequest, type ThemeList } from '@/api';
import { patchSavedBrew, seedCreatedBrew } from './cache';
import { brewForEdit, docOf, saveResponse } from './testing';

const themes: ThemeList = { static: [], user: [] };

function clientWith(brew = brewForEdit()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60_000 } } });
  queryClient.setQueryData(queryKeys.brews.edit(brew.editId), brew);
  queryClient.setQueryData(queryKeys.themes.list(), themes);
  const themesStale = () => queryClient.getQueryState(queryKeys.themes.list())?.isInvalidated ?? false;
  return { queryClient, themesStale };
}

const request = (meta: SaveBrewRequest['meta']): SaveBrewRequest => ({ baseVersion: 1, doc: docOf('Hello'), style: '', snippets: null, meta, docSchemaVersion: 1 });

describe('patchSavedBrew and the theme list', () => {
  it('tagging a brew meta:theme refreshes the theme list', () => {
    const { queryClient, themesStale } = clientWith();
    patchSavedBrew(queryClient, 'edit-1', saveResponse(2), request({ tags: ['meta:theme'] }));
    expect(themesStale()).toBe(true);
    expect(queryClient.getQueryData<{ meta: { tags: string[] } }>(queryKeys.brews.edit('edit-1'))?.meta.tags).toEqual(['meta:theme']);
  });

  it('untagging or renaming a theme brew refreshes it', () => {
    const theme = brewForEdit({ meta: { ...brewForEdit().meta, title: 'My theme', tags: ['meta:theme'] } });
    const untag = clientWith(theme);
    patchSavedBrew(untag.queryClient, 'edit-1', saveResponse(2, { title: 'My theme' }), request({ tags: [] }));
    expect(untag.themesStale()).toBe(true);
    const rename = clientWith(theme);
    patchSavedBrew(rename.queryClient, 'edit-1', saveResponse(2, { title: 'Renamed theme' }), request(null));
    expect(rename.themesStale()).toBe(true);
  });

  it('other saves leave it alone', () => {
    const plain = clientWith();
    patchSavedBrew(plain.queryClient, 'edit-1', saveResponse(2), request(null));
    patchSavedBrew(plain.queryClient, 'edit-1', saveResponse(3), request({ title: 'Brew', tags: ['type:adventure'] }));
    expect(plain.themesStale()).toBe(false);
    const theme = clientWith(brewForEdit({ meta: { ...brewForEdit().meta, tags: ['meta:theme'] } }));
    patchSavedBrew(theme.queryClient, 'edit-1', saveResponse(2), request({ tags: ['meta:theme'] }));
    expect(theme.themesStale()).toBe(false);
  });
});

describe('seedCreatedBrew and the theme list', () => {
  it('a created brew tagged meta:theme refreshes it; others do not', () => {
    const plain = clientWith();
    seedCreatedBrew(plain.queryClient, brewForEdit({ editId: 'new-1' }));
    expect(plain.themesStale()).toBe(false);
    const theme = clientWith();
    seedCreatedBrew(theme.queryClient, brewForEdit({ editId: 'new-2', meta: { ...brewForEdit().meta, tags: ['meta:theme'] } }));
    expect(theme.themesStale()).toBe(true);
    expect(theme.queryClient.getQueryData(queryKeys.brews.edit('new-2'))).toMatchObject({ editId: 'new-2' });
  });
});

// Keeps TanStack Query's copy of the brew in step with what autosave stored, as useSaveBrew and
// useCreateBrew do (web/src/api/brews.ts), so other readers of the edit query (metadata dialog,
// a remount after /new → /edit/:editId) see the saved version. User themes are brews tagged
// meta:theme: a save or create that adds, removes or renames one refreshes the theme list too.
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys, type BrewForEdit, type BrewMeta, type SaveBrewRequest, type SaveBrewResponse } from '@/api';

/** The tag that makes a brew a user theme (ThemeContracts.cs, BrewTags.cs). */
export const THEME_TAG = 'meta:theme';

const isTheme = (tags: readonly string[] | null | undefined): boolean => tags?.includes(THEME_TAG) ?? false;

const sameTags = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((tag, i) => tag === b[i]);

function savedMeta(meta: SaveBrewRequest['meta'], stored: BrewMeta): BrewMeta {
  if (!meta) return stored;
  return {
    title: meta.title ?? stored.title,
    description: meta.description ?? stored.description,
    tags: meta.tags ?? stored.tags,
    lang: meta.lang ?? stored.lang,
    theme: meta.theme ?? stored.theme,
    published: meta.published ?? stored.published,
    thumbnailUrl: meta.thumbnailUrl == null ? stored.thumbnailUrl : meta.thumbnailUrl || null,
  };
}

/** A save succeeded: patch the cached BrewForEdit and refresh the lists that show brews. */
export function patchSavedBrew(queryClient: QueryClient, editId: string, saved: SaveBrewResponse, body: SaveBrewRequest): void {
  const old = queryClient.getQueryData<BrewForEdit>(queryKeys.brews.edit(editId));
  queryClient.setQueryData<BrewForEdit>(queryKeys.brews.edit(editId), (cached) =>
    cached
      ? {
          ...cached,
          version: saved.version,
          updatedAt: saved.updatedAt,
          pageCount: saved.pageCount,
          authors: saved.authors,
          doc: body.doc,
          style: body.style ?? '',
          snippets: body.snippets ?? null,
          meta: { ...savedMeta(body.meta, cached.meta), title: saved.title },
        }
      : cached,
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
  // The theme list names user themes: refresh it when this brew became one, stopped being one,
  // or is one under a new title. Without the cached brew, any save of a theme-tagged brew.
  const tags = body.meta?.tags ?? old?.meta.tags ?? null;
  const themeChanged = old
    ? (isTheme(old.meta.tags) || isTheme(tags)) && (!sameTags(old.meta.tags, tags ?? old.meta.tags) || old.meta.title !== saved.title)
    : isTheme(tags);
  if (themeChanged) void queryClient.invalidateQueries({ queryKey: queryKeys.themes.all });
}

/** A brew was created (first save of /new, or a copy): seed its edit query. */
export function seedCreatedBrew(queryClient: QueryClient, brew: BrewForEdit): void {
  queryClient.setQueryData(queryKeys.brews.edit(brew.editId), brew);
  void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
  if (isTheme(brew.meta.tags)) void queryClient.invalidateQueries({ queryKey: queryKeys.themes.all });
}

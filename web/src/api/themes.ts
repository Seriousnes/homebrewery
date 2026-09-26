// Themes (plan §8.7): the theme list for pickers and a theme's bundle (inheritance chain). The
// canvas loads bundles through web/src/editor/canvas/themeLoader.ts (with its static fallback);
// these are for UI that lists or describes themes.
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, type CallOptions, unwrap } from './client';
import type { ApiError } from './errors';
import type { QueryOverrides } from './hookOptions';
import { queryKeys } from './keys';
import type { ThemeBundle, ThemeList } from './types';

/** Static themes plus user themes (the caller's own first). */
export async function fetchThemes({ client = api, signal }: CallOptions = {}): Promise<ThemeList> {
  return unwrap(client.GET('/api/themes', { signal }), { method: 'GET', url: '/api/themes' });
}

/** A theme's chain, root first. 404 unknown, 422 broken chain (extension `chain`), 423 locked. */
export async function fetchThemeBundle(theme: string, { client = api, signal }: CallOptions = {}): Promise<ThemeBundle> {
  return unwrap(client.GET('/api/themes/{theme}/bundle', { params: { path: { theme } }, signal }), {
    method: 'GET',
    url: `/api/themes/${theme}/bundle`,
  });
}

export const themeQueries = {
  list: () =>
    queryOptions<ThemeList, ApiError>({
      queryKey: queryKeys.themes.list(),
      queryFn: ({ signal }) => fetchThemes({ signal }),
      staleTime: 5 * 60_000,
    }),
  bundle: (theme: string) =>
    queryOptions<ThemeBundle, ApiError>({
      queryKey: queryKeys.themes.bundle(theme),
      queryFn: ({ signal }) => fetchThemeBundle(theme, { signal }),
      staleTime: 5 * 60_000,
    }),
};

export function useThemes(overrides?: QueryOverrides<ThemeList>) {
  return useQuery({ ...themeQueries.list(), ...overrides });
}

export function useThemeBundle(theme: string | undefined, overrides?: QueryOverrides<ThemeBundle>) {
  return useQuery({ ...themeQueries.bundle(theme ?? ''), enabled: Boolean(theme), ...overrides });
}

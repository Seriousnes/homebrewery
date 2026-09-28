import { useEffect, useMemo, useState } from 'react';
import type { ThemeSnippetRef } from '../canvas/themeLoader';
import { compileSnippets, staticSnippetIds } from './compileSnippets';
import { loadStaticSnippets } from './staticSnippets';
import type { ThemeSnippetGroup } from './themeSnippets';

export interface SnippetGroupsState {
  status: 'loading' | 'ready' | 'error';
  /** Compiled groups (text and style view); [] while loading. */
  groups: ThemeSnippetGroup[];
  error: string | null;
}

/**
 * The compiled snippet groups for a theme chain's snippet sources (ThemeChain.snippets, e.g.
 * from EditorCanvas's ready status or useThemeBundle) plus the brew's own snippets. Static
 * snippet modules load on demand; the result is recompiled when an input changes. Pass stable
 * values (memoize `refs`).
 */
export function useSnippetGroups(
  refs: readonly ThemeSnippetRef[] | null | undefined,
  userSnippets?: unknown,
  brewTitle?: string | null,
): SnippetGroupsState {
  const ids = useMemo(() => staticSnippetIds(refs ?? []), [refs]);
  const idsKey = ids.join('\n');
  const [loaded, setLoaded] = useState<{ key: string; groups: Record<string, ThemeSnippetGroup[]>; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(ids.map(async (id) => [id, await loadStaticSnippets(id)] as const))
      .then((entries) => {
        if (!cancelled) setLoaded({ key: idsKey, groups: Object.fromEntries(entries), error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoaded({ key: idsKey, groups: {}, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
    // ids is derived from idsKey.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return useMemo<SnippetGroupsState>(() => {
    if (!refs || !loaded || loaded.key !== idsKey) return { status: 'loading', groups: [], error: null };
    const groups = compileSnippets({ refs, staticGroups: loaded.groups, userSnippets, brewTitle: brewTitle ?? null });
    return { status: loaded.error ? 'error' : 'ready', groups, error: loaded.error };
  }, [refs, loaded, idsKey, userSnippets, brewTitle]);
}

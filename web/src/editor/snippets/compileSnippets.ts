// The Insert menu's snippet groups for a theme chain: port of compileSnippets and
// mergeCustomizer from legacy/client/homebrew/editor/snippetbar/snippetbar.jsx:127-155.
//
// The theme bundle lists snippet sources root first: static themes as "V3_<key>" (their
// themes/V3/<key>/snippets.js), user themes as { name, snippets }. Static groups are merged
// parent to child by groupName; inside a group, a child's snippet replaces the parent's snippet
// of the same name. User themes' snippets and the brew's own go into one "Brew Snippets" group
// at the end (brewSnippetsToJSON), as upstream.
import type { ThemeSnippetRef } from '../canvas/themeLoader';
import { loadStaticSnippets } from './staticSnippets';
import type { ThemeSnippet, ThemeSnippetGroup } from './themeSnippets';
import { userSnippetGroup, type UserThemeSnippetsRef } from './userSnippets';

/**
 * Upstream's mergeCustomizer for the `snippets` of two groups with the same name:
 * `_.reverse(_.unionBy(_.reverse(child), _.reverse(parent), 'name'))`, keeping entries with a
 * generator or subsnippets. Result: the parent's snippets the child doesn't override (in their
 * order), then the child's (in theirs).
 */
export function mergeSnippetLists(parent: readonly ThemeSnippet[] | undefined, child: readonly ThemeSnippet[] | undefined): ThemeSnippet[] {
  const seen = new Set<string>();
  const union: ThemeSnippet[] = [];
  for (const list of [child ?? [], parent ?? []]) {
    for (const snippet of [...list].reverse()) {
      if (seen.has(snippet.name)) continue;
      seen.add(snippet.name);
      union.push(snippet);
    }
  }
  return union.reverse().filter((s) => Boolean(s.gen) || Boolean(s.subsnippets));
}

/**
 * Merges a child theme's groups into the groups compiled so far (lodash mergeWith by
 * groupName): a group present in both keeps its position and takes the child's name, icon and
 * view; new groups are appended. Inputs are not modified.
 */
export function mergeSnippetGroups(compiled: readonly ThemeSnippetGroup[], child: readonly ThemeSnippetGroup[]): ThemeSnippetGroup[] {
  const byName = new Map<string, ThemeSnippetGroup>(compiled.map((g) => [g.groupName, g]));
  for (const group of child) {
    if (!group || typeof group.groupName !== 'string') continue;
    const old = byName.get(group.groupName);
    byName.set(group.groupName, { ...old, ...group, snippets: mergeSnippetLists(old?.snippets, group.snippets) });
  }
  return [...byName.values()];
}

export interface CompileSnippetsInput {
  /** The theme bundle's snippet sources, root first (ThemeChain.snippets). */
  refs: readonly ThemeSnippetRef[];
  /** Loaded static snippet modules by id ("V3_Blank" → groups). Missing ids count as empty. */
  staticGroups: Readonly<Record<string, readonly ThemeSnippetGroup[]>>;
  /** The brew's own snippets (brews.snippets, any stored shape; see userSnippets.ts). */
  userSnippets?: unknown;
  /** The brew title (the submenu of the brew's own snippets; "New Document" when empty). */
  brewTitle?: string | null;
}

/** The compiled groups (text and style view), in menu order. Pure. */
export function compileSnippets({ refs, staticGroups, userSnippets, brewTitle }: CompileSnippetsInput): ThemeSnippetGroup[] {
  let compiled: ThemeSnippetGroup[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string') continue; // user themes: see userSnippetGroup
    compiled = mergeSnippetGroups(compiled, staticGroups[ref] ?? []);
  }
  const user = userSnippetGroup(brewTitle, userSnippets, refs.filter((r): r is UserThemeSnippetsRef => typeof r !== 'string'));
  if (user) compiled.push(user);
  return compiled;
}

/** The static snippet ids a chain needs ("V3_…"), without duplicates. */
export const staticSnippetIds = (refs: readonly ThemeSnippetRef[]): string[] => [
  ...new Set(refs.filter((r): r is string => typeof r === 'string')),
];

/** Loads the static snippet modules of `refs` and compiles the groups. */
export async function loadSnippetGroups(input: Omit<CompileSnippetsInput, 'staticGroups'>): Promise<ThemeSnippetGroup[]> {
  const ids = staticSnippetIds(input.refs);
  const loaded = await Promise.all(ids.map(async (id) => [id, await loadStaticSnippets(id)] as const));
  return compileSnippets({ ...input, staticGroups: Object.fromEntries(loaded) });
}

/** Groups of one view: 'text' for the Insert menu, 'style' for the Style drawer. */
export const groupsForView = (groups: readonly ThemeSnippetGroup[], view: 'text' | 'style'): ThemeSnippetGroup[] =>
  groups.filter((g) => g.view === view);
